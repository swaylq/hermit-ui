// hermit's own tools, as a pi extension.
//
// pi has no MCP, so the tools the claude path gets from `mcp-stub.cjs` are
// registered here instead and loaded with `pi --extension <this file>`. The
// wire contract is identical — the same dashboard endpoints, the same payloads
// — so a tool behaves the same whichever backend the session runs on.
//
// pi loads an extension by importing its DEFAULT export and calling it with the
// ExtensionAPI. jiti transpiles, so this stays a .ts file.
//
// Session identity and dashboard credentials arrive through the environment,
// set by PiRpcRuntime when it spawns the child.
//
// NOTE: the HTTP contract below is duplicated from mcp-stub.cjs on purpose.
// That file is the live path for ~24 claude sessions; refactoring it to share
// code with brand-new pi code would put the fleet at risk for a tidiness win.
// If the dashboard's endpoints change, BOTH must move together.

import fs from 'node:fs';
import path from 'node:path';

type ToolContext = { input: Record<string, unknown> };

const DASHBOARD_URL = process.env.HERMIT_DASHBOARD_URL ?? '';
const KEY = process.env.HERMIT_KEY ?? '';
const SESSION_ID = process.env.HERMIT_SESSION_ID ?? '';

/** How long `ask` waits for a human. Matches the MCP stub's 4h5m ceiling. */
const ASK_TIMEOUT_MS = 4 * 60 * 60 * 1000 + 5 * 60 * 1000;

function requireEnv(): void {
  if (!DASHBOARD_URL || !KEY || !SESSION_ID) {
    throw new Error('hermit tools need HERMIT_DASHBOARD_URL, HERMIT_KEY and HERMIT_SESSION_ID');
  }
}

async function trpcMutate(procedure: string, input: unknown): Promise<unknown> {
  requireEnv();
  const r = await fetch(`${DASHBOARD_URL}/api/trpc/${procedure}?batch=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': KEY },
    body: JSON.stringify({ 0: { json: input } }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${procedure} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  requireEnv();
  const r = await fetch(`${DASHBOARD_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': KEY },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

/**
 * Upload a file to the dashboard and get back {url, mimeType, kind, ...}.
 *
 * Images go up with their real MIME so /api/upload runs its image path (the
 * <=2000px `.safe.` sidecar that stops an oversized image from wedging a
 * session); everything else uploads as octet-stream and the dashboard validates
 * the extension against its own allowlist. Mirrors mcp-stub.cjs's uploadFile.
 */
async function uploadFile(filePath: string): Promise<Record<string, unknown>> {
  requireEnv();
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  const mime = IMAGE_MIME[ext] ?? 'application/octet-stream';
  const body = new FormData();
  body.append('sessionId', SESSION_ID);
  body.append('file', new Blob([fs.readFileSync(filePath)], { type: mime }), path.basename(filePath));
  const r = await fetch(`${DASHBOARD_URL}/api/upload`, {
    method: 'POST', headers: { 'x-asst-key': KEY }, body,
  });
  if (!r.ok) throw new Error(`upload → ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return r.json() as Promise<Record<string, unknown>>;
}

async function postChatMessage(content: unknown[], tag: string): Promise<void> {
  await postJson('/api/sync/chat-message', {
    items: [{
      sessionId: SESSION_ID,
      role: 'assistant',
      content,
      externalId: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      claudeSessionId: null,
    }],
  });
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} required`);
  return v;
};

export default function hermitTools(pi: any): void {
  pi.registerTool({
    name: 'set_session_title',
    description:
      'Rename the current chat session shown in the dashboard sidebar. Use when the conversation has settled on a clear topic. Keep titles short (<=60 chars).',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: 'New session title.' } },
      required: ['title'],
    },
    async execute(_id: string, params: ToolContext['input']) {
      const title = str(params.title, 'title').slice(0, 120);
      await trpcMutate('chat.setTitle', { id: SESSION_ID, title });
      return { content: [{ type: 'text', text: `ok — title set to "${title}"` }] };
    },
  });

  pi.registerTool({
    name: 'log_status',
    description:
      'Post a short progress note into this chat so the user can see what you are doing during a long task. Not a substitute for your final answer.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The status line.' } },
      required: ['text'],
    },
    async execute(_id: string, params: ToolContext['input']) {
      const text = str(params.text, 'text');
      await postChatMessage([{ type: 'text', text }], 'pi-status');
      return { content: [{ type: 'text', text: 'ok — status posted' }] };
    },
  });

  for (const kind of ['attach_file', 'attach_image'] as const) {
    pi.registerTool({
      name: kind,
      description:
        kind === 'attach_image'
          ? 'Deliver an image from disk into the chat so the user can see it inline.'
          : 'Deliver a file from disk into the chat so the user can download it.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path on this machine.' },
          caption: { type: 'string', description: 'Optional one-line caption.' },
        },
        required: ['filePath'],
      },
      async execute(_id: string, params: ToolContext['input']) {
        const filePath = str(params.filePath, 'filePath');
        if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
        const up = await uploadFile(filePath);
        if (kind === 'attach_image' && up.kind && up.kind !== 'image') {
          throw new Error(`not an image: ${filePath}. Use attach_file for non-image files.`);
        }

        const blocks: unknown[] = [];
        const caption = typeof params.caption === 'string' ? params.caption.trim() : '';
        if (caption) blocks.push({ type: 'text', text: caption });

        if (kind === 'attach_image') {
          blocks.push({
            type: 'image',
            source: { type: 'url', url: up.url, media_type: up.mimeType },
            ...(typeof up.width === 'number' && typeof up.height === 'number'
              ? { width: up.width, height: up.height }
              : {}),
          });
        } else {
          // Same shape mcp-stub.cjs emits — url nested under `source`, like
          // images. A flat {url} renders as an empty bubble.
          blocks.push({
            type: 'file',
            source: { type: 'url', url: up.url, media_type: up.mimeType || 'application/octet-stream' },
            name: (typeof up.name === 'string' && up.name) || path.basename(filePath),
          });
        }

        await postChatMessage(blocks, 'attach');
        return { content: [{ type: 'text', text: `ok — ${kind} sent (${String(up.url)})` }] };
      },
    });
  }

  pi.registerTool({
    name: 'ask',
    description:
      'Ask the user a multiple-choice question and BLOCK until they answer in the dashboard. Use whenever you need them to pick a direction. Keep options short (2-6).',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, description: { type: 'string' } },
            required: ['label'],
          },
        },
        multiSelect: { type: 'boolean' },
      },
      required: ['question', 'options'],
    },
    async execute(_id: string, params: ToolContext['input']) {
      const question = str(params.question, 'question');
      const options = Array.isArray(params.options) ? params.options : [];
      if (options.length === 0) throw new Error('options required');

      const created = (await postJson('/api/sync/interaction', {
        sessionId: SESSION_ID,
        kind: 'ask',
        payload: { question, options, multiSelect: Boolean(params.multiSelect) },
      })) as { id?: string } | null;
      const id = created?.id;
      if (!id) throw new Error('could not create the interaction');

      // Poll until answered. The dashboard writes the answer back onto the row;
      // there is no push channel into a pi child.
      const deadline = Date.now() + ASK_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const r = await fetch(`${DASHBOARD_URL}/api/sync/interaction?id=${encodeURIComponent(id)}`, {
          headers: { 'x-asst-key': KEY },
        });
        if (!r.ok) continue;
        const row = (await r.json()) as { answeredAt?: string | null; answer?: unknown } | null;
        if (row?.answeredAt) {
          return { content: [{ type: 'text', text: `User answered: ${JSON.stringify(row.answer)}` }] };
        }
      }
      throw new Error('ask timed out waiting for the user');
    },
  });
}
