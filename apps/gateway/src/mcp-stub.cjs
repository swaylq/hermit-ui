#!/usr/bin/env node
// MCP stub spawned by `claude --mcp-config` once per tmux chat session.
//
// Reads HERMIT_SESSION_ID + HERMIT_DASHBOARD_URL + HERMIT_KEY from env (set by
// chat-runner when assembling the --mcp-config payload).
//
// Exposes tools the agent can call mid-turn that route back to the dashboard:
//   - set_session_title(title)        rename this chat session
//   - log_status(text)                drop a system note in the timeline
//   - attach_image(filePath, caption) upload a local image + render inline
//
// Talks JSON-RPC 2.0 over stdio per MCP spec — no SDK needed (the SDK pulls in
// too many deps for what is a 200-line transport).

'use strict';

const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_ID = process.env.HERMIT_SESSION_ID || '';
const DASHBOARD_URL = process.env.HERMIT_DASHBOARD_URL || 'http://127.0.0.1:4101';
const KEY = process.env.HERMIT_KEY || '';

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function sendJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id, result) {
  sendJson({ jsonrpc: '2.0', id, result });
}
function sendError(id, code, message) {
  sendJson({ jsonrpc: '2.0', id, error: { code, message } });
}

async function trpcMutate(procedure, input) {
  const url = `${DASHBOARD_URL}/api/trpc/${procedure}?batch=1`;
  const body = { 0: { json: input } };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${procedure} → ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

async function postChatMessage(items) {
  const r = await fetch(`${DASHBOARD_URL}/api/sync/chat-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': KEY },
    body: JSON.stringify({ items }),
  });
  if (!r.ok) throw new Error(`sync/chat-message → ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

// Upload a file from local disk to /api/upload (multipart). Returns the
// dashboard's response body (url, originalUrl, mimeType, width, height, …).
async function uploadFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  const mt = MIME_BY_EXT[ext];
  if (!mt) throw new Error(`unsupported extension: ${ext || '<empty>'}`);
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('sessionId', SESSION_ID);
  fd.append('file', new Blob([buf], { type: mt }), path.basename(filePath));
  const r = await fetch(`${DASHBOARD_URL}/api/upload`, {
    method: 'POST',
    headers: { 'x-asst-key': KEY },
    body: fd,
  });
  if (!r.ok) throw new Error(`upload → ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

const TOOLS = [
  {
    name: 'set_session_title',
    description:
      'Rename the current chat session shown in the dashboard sidebar. Use when the conversation has settled on a clear topic. Keep titles short (≤60 chars).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'New session title (will be truncated to 120 chars).' },
      },
      required: ['title'],
    },
  },
  {
    name: 'log_status',
    description:
      'Drop a short system note into the chat timeline — useful for "starting long task X" / "checkpoint Y reached" updates that the user benefits from seeing in-line.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The status line (markdown supported).' },
      },
      required: ['text'],
    },
  },
  {
    name: 'attach_image',
    description:
      'Send an image to the user. Pass an absolute path to a PNG / JPEG / GIF / WebP file on the local filesystem (e.g. a screenshot you just produced, a generated diagram). Optional caption renders above the image. The dashboard auto-resizes anything over 2000px long-edge so this is safe to use on full-page screenshots.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the image file on this machine.' },
        caption: { type: 'string', description: 'Optional caption rendered above the image in the chat.' },
      },
      required: ['filePath'],
    },
  },
];

async function dispatchTool(name, args) {
  if (!SESSION_ID) throw new Error('HERMIT_SESSION_ID missing');
  if (name === 'set_session_title') {
    if (typeof args?.title !== 'string') throw new Error('title required');
    await trpcMutate('chat.setTitle', { id: SESSION_ID, title: args.title.slice(0, 120) });
    return `ok — title set to "${args.title.slice(0, 120)}"`;
  }
  if (name === 'log_status') {
    if (typeof args?.text !== 'string') throw new Error('text required');
    await postChatMessage([
      {
        sessionId: SESSION_ID,
        role: 'system',
        content: [{ type: 'text', text: args.text }],
        externalId: `status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    ]);
    return 'ok — logged';
  }
  if (name === 'attach_image') {
    const fp = args?.filePath;
    if (typeof fp !== 'string' || !fp) throw new Error('filePath required');
    if (!fs.existsSync(fp)) throw new Error(`file not found: ${fp}`);
    const up = await uploadFile(fp);
    const blocks = [];
    if (typeof args?.caption === 'string' && args.caption.trim()) {
      blocks.push({ type: 'text', text: args.caption.trim() });
    }
    blocks.push({
      type: 'image',
      source: { type: 'url', url: up.url, media_type: up.mimeType },
      ...(typeof up.width === 'number' && typeof up.height === 'number'
        ? { width: up.width, height: up.height }
        : {}),
    });
    await postChatMessage([
      {
        sessionId: SESSION_ID,
        role: 'assistant',
        content: blocks,
        externalId: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    ]);
    return `ok — image attached (${up.width ?? '?'}×${up.height ?? '?'} → ${up.url})`;
  }
  throw new Error(`unknown tool: ${name}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      sendResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hermit-mcp', version: '0.2.0' },
      });
      return;
    }
    if (method === 'notifications/initialized') {
      // no-op
      return;
    }
    if (method === 'tools/list') {
      sendResult(id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      try {
        const text = await dispatchTool(name, args || {});
        sendResult(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        sendResult(id, {
          isError: true,
          content: [{ type: 'text', text: String(e?.message || e) }],
        });
      }
      return;
    }
    if (method === 'resources/list') {
      sendResult(id, { resources: [] });
      return;
    }
    if (method === 'prompts/list') {
      sendResult(id, { prompts: [] });
      return;
    }
    // Unknown method
    if (id !== undefined) sendError(id, -32601, `method not found: ${method}`);
  } catch (e) {
    if (id !== undefined) sendError(id, -32603, String(e?.message || e));
  }
});

// Keep process alive until stdin closes.
process.stdin.on('end', () => process.exit(0));
