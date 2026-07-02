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
//   - attach_file(filePath, caption)  upload a local file + render a download chip
//   - cron_create(prompt, intervalMinutes, jitterMinutes?, title?)  schedule a cron
//   - cron_list()                     list this agent's crons
//   - cron_delete(id)                 delete one of this agent's crons
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
// The orchestrator ("义脑") session is launched by chat-runner with HERMIT_BRAIN=1.
// Only then are the cross-agent brain tools (roster / agent_activity / dispatch /
// dispatch_result) registered + accepted — a normal agent never gets them.
const BRAIN = process.env.HERMIT_BRAIN === '1';

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  // office docs (so the download chip carries a correct content-type)
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
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

async function trpcQuery(procedure, input) {
  const url = `${DASHBOARD_URL}/api/trpc/${procedure}?batch=1&input=`
    + encodeURIComponent(JSON.stringify({ 0: { json: input } }));
  const r = await fetch(url, { headers: { 'x-asst-key': KEY } });
  if (!r.ok) throw new Error(`${procedure} → ${r.status}: ${await r.text().catch(() => '')}`);
  const j = await r.json();
  return j?.[0]?.result?.data?.json;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create a blocking interaction (kind=question here) and the inline card the
// browser renders. Returns { id }.
async function createInteraction(body) {
  const r = await fetch(`${DASHBOARD_URL}/api/sync/interaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': KEY },
    body: JSON.stringify({ sessionId: SESSION_ID, ...body }),
  });
  if (!r.ok) throw new Error(`sync/interaction → ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

async function pollInteraction(id) {
  const r = await fetch(`${DASHBOARD_URL}/api/sync/interaction?id=${encodeURIComponent(id)}`, {
    headers: { 'x-asst-key': KEY },
  });
  if (!r.ok) throw new Error(`sync/interaction GET → ${r.status}`);
  return r.json();
}

// Block until the user clicks a button (or the 4h ceiling). The hermit MCP
// server's `timeout` in the gateway --mcp-config is set just ABOVE ASK_MAX_MS so
// this clean return always fires before claude force-kills the tool call.
const ASK_MAX_MS = 4 * 60 * 60 * 1000;
const ASK_POLL_MS = 2000;
async function waitForAnswer(id) {
  const deadline = Date.now() + ASK_MAX_MS;
  while (Date.now() < deadline) {
    await sleep(ASK_POLL_MS);
    let st;
    try {
      st = await pollInteraction(id);
    } catch {
      continue; // transient network blip — keep waiting
    }
    if (st && st.status && st.status !== 'pending') {
      return st.decision && Array.isArray(st.decision.answers) ? st.decision.answers : [];
    }
  }
  return null; // timed out without an answer
}

// Upload a file from local disk to /api/upload (multipart). Returns the
// dashboard's response body (url, originalUrl, mimeType, width, height, …).
async function uploadFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  // Image extensions upload with their real MIME so /api/upload runs the image
  // path (≤2000px .safe. sidecar). Everything else goes up as octet-stream;
  // /api/upload validates the extension against its SAFE_FILE_EXT_SET allowlist
  // and returns kind:'file'. (attach_image guards on the returned kind.)
  const mt = MIME_BY_EXT[ext] || 'application/octet-stream';
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

// Flatten Anthropic content blocks to plain text (drops tool_use / tool_result /
// image blocks) — used to summarize an agent's last turn for the brain tools.
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
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
  {
    name: 'attach_file',
    description:
      'Send a downloadable file to the user in the chat. Pass an absolute path to a text / code / markdown / PDF / CSV / JSON / YAML / HTML / SVG file, an office document (docx / xlsx / pptx / doc / xls / ppt / odt / ods / odp), OR an archive (zip / tar / gz / tgz / bz2 / xz / 7z / rar / zst), on the local filesystem — it appears as a download chip the user clicks to save, under its real filename. For images use attach_image instead (renders inline). Allowed: the text / code / document / office allowlist plus archives — ≤25 MB (not arbitrary binaries or executables). Optional caption renders above the file.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file on this machine.' },
        caption: { type: 'string', description: 'Optional caption rendered above the file chip in the chat.' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'cron_create',
    description:
      "Schedule a durable recurring task for THIS agent. Every intervalMinutes (± jitterMinutes of random float), the gateway runs `prompt` as a fresh claude turn in this agent's directory and records the result. It survives restarts and shows on the dashboard /cron page. Use when the user asks for a 定时任务 / scheduled / recurring task. For an in-conversation loop whose results stream into THIS chat, use the loop skill instead.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task prompt to run on each fire.' },
        intervalMinutes: { type: 'number', description: 'Run every N minutes (minimum 1).' },
        jitterMinutes: { type: 'number', description: 'Optional ± random float on the fire time, in minutes (default 0).' },
        title: { type: 'string', description: 'Optional short label shown in the cron list.' },
      },
      required: ['prompt', 'intervalMinutes'],
    },
  },
  {
    name: 'cron_list',
    description:
      "List THIS agent's scheduled cron tasks (id, title, interval, last status). Use to report current crons or to find an id before deleting one.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cron_delete',
    description:
      "Delete one of THIS agent's cron tasks by id (get the id from cron_list). Use when the user asks to stop / remove a scheduled task.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The cron id (from cron_list).' } },
      required: ['id'],
    },
  },
  {
    name: 'ask',
    description:
      "Ask the user a multiple-choice question and BLOCK until they answer in the dashboard. Use this — NOT the built-in AskUserQuestion tool — whenever you need the user to pick from options or confirm a direction. AskUserQuestion renders a TUI modal the dashboard user never sees (the turn hangs); this renders clickable option buttons in the chat and returns their choice. The call blocks until the user clicks (up to ~4h). Keep options short (2–6). Set multiSelect when more than one may apply.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to show the user.' },
        options: {
          type: 'array',
          description: 'The choices. 2–6 recommended.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short choice text the user clicks.' },
              description: { type: 'string', description: 'Optional one-line explanation of this choice.' },
            },
            required: ['label'],
          },
        },
        multiSelect: { type: 'boolean', description: 'Allow selecting more than one option (default false).' },
      },
      required: ['question', 'options'],
    },
  },
];

// ── Brain-only tools (registered + accepted only when HERMIT_BRAIN=1) ─────────
// The orchestrator ("义脑") manages every OTHER agent on this machine. These wrap
// the EXISTING machine-scoped tRPC — the stub already holds the machine key — so
// the brain sees + delegates without ever handling the key or doing work itself.
const BRAIN_TOOLS = [
  {
    name: 'roster',
    description:
      "List the OTHER agents on this machine (you, the orchestrator, are excluded) with their skills + session counts — your routing table. Call this first to see who can take a task; for an agent's role/recent work follow up with agent_activity.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_activity',
    description:
      "Inspect ONE agent: its identity/role summary, skills, recent chat sessions (+ the latest turn's text) and crons. Use it to understand what an agent does and what it has been doing — before routing work to it, or when writing your digest. Optional `since` (ISO timestamp) limits sessions to those active after it (incremental digests).",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The agent name (from roster).' },
        since: { type: 'string', description: 'Optional ISO timestamp — only sessions active after this.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'dispatch',
    description:
      "Delegate a task to ANOTHER agent — you (Brain) never do the work yourself. One-shot by default: sends `prompt` to a dispatch session on the target and returns its sessionId (read the result later with dispatch_result). To avoid piling up sessions (each is a live claude process), call dispatch_list first and pass reuseSessionId to send into an EXISTING idle dispatch session on that agent; omit it to open a fresh one. Pass recurring={intervalMinutes} to make it a cron on the target instead. Pick the target from roster / agent_activity.",
    inputSchema: {
      type: 'object',
      properties: {
        agentName: { type: 'string', description: 'Target agent (on the roster, not yourself).' },
        prompt: { type: 'string', description: 'The task to hand to that agent.' },
        reuseSessionId: { type: 'string', description: 'Optional — an existing idle dispatch session (from dispatch_list) on this agent to send into, instead of opening a new one. Ignored if it is not a valid open dispatch session for this agent.' },
        title: { type: 'string', description: 'Optional short label for a NEW session/cron (ignored when reusing).' },
        recurring: {
          type: 'object',
          description: 'Make it a recurring cron on the target instead of a one-shot.',
          properties: {
            intervalMinutes: { type: 'number', description: 'Run every N minutes (≥1).' },
            jitterMinutes: { type: 'number', description: 'Optional ± random minutes.' },
          },
          required: ['intervalMinutes'],
        },
      },
      required: ['agentName', 'prompt'],
    },
  },
  {
    name: 'dispatch_result',
    description:
      "Read back a one-shot dispatch: the target session's latest assistant text + whether it is still working. Optional `waitMs` (≤120000) briefly polls for a result still being produced. Dispatch is asynchronous — call this on a LATER turn (or after a short wait), not expecting an instant reply.",
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The sessionId returned by dispatch.' },
        waitMs: { type: 'number', description: 'Optional poll window in ms (capped at 120000).' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'dispatch_list',
    description:
      "List YOUR open dispatch sessions (the one-shot conversations you've opened on other agents). Each is { sessionId, agent, title, working, lastActivity }. Use it BEFORE dispatching — to reuse an idle session on the target instead of opening a new one — and in your daily dream, to find finished sessions to reap with dispatch_close. Each session is a live claude process, so keep the list short.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dispatch_close',
    description:
      "Reap a finished dispatch session you no longer need — closes the conversation and frees the worker's idle claude process. Do this in your daily dream for dispatches that are done and whose result you've already used. Refuses anything that isn't one of your dispatch sessions.",
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'A dispatch sessionId (from dispatch_list).' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'kb_list',
    description:
      "List every knowledge base on this machine: { id, name, slug, intro, autoIntro, docCount, introUpdatedAt, contentUpdatedAt }. Use it in your daily dream to refresh intros — for each base with autoIntro true AND contentUpdatedAt newer than introUpdatedAt, read its docs and rewrite the intro.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kb_read_docs',
    description:
      "Read a knowledge base's documents in full: { name, intro, docs: [{ title, filename, content }] }. Use it before rewriting an intro so your summary reflects the actual content.",
    inputSchema: {
      type: 'object',
      properties: { baseId: { type: 'string', description: 'The knowledge base id (from kb_list).' } },
      required: ['baseId'],
    },
  },
  {
    name: 'kb_set_intro',
    description:
      "Write a knowledge base's intro — a concise 1-3 sentence summary of what it contains and when an agent should consult it. This is the ONLY part always kept in an agent's context, so keep it tight. Preserves the autoIntro flag; re-materializes the base for attached agents.",
    inputSchema: {
      type: 'object',
      properties: {
        baseId: { type: 'string', description: 'The knowledge base id (from kb_list).' },
        intro: { type: 'string', description: 'The new intro text (1-3 sentences).' },
      },
      required: ['baseId', 'intro'],
    },
  },
];
const BRAIN_TOOL_NAMES = new Set(BRAIN_TOOLS.map((t) => t.name));

async function dispatchBrainTool(name, args) {
  if (name === 'roster') {
    const agents = (await trpcQuery('agents.list', null)) || [];
    const workers = (Array.isArray(agents) ? agents : [])
      .filter((a) => !a.isOrchestrator)
      .map((a) => ({ name: a.name, skills: a.skillNames || [], sessions: a.sessionCount ?? 0, active: a.activeSessionCount ?? 0 }));
    return JSON.stringify({ agents: workers });
  }
  if (name === 'agent_activity') {
    const target = args?.name;
    if (typeof target !== 'string' || !target) throw new Error('name required');
    const since = typeof args?.since === 'string' ? Date.parse(args.since) : NaN;
    const detail = await trpcQuery('agents.byName', { name: target });
    const agent = detail?.agent || null;
    let sessions = (await trpcQuery('chat.listSessions', { agentName: target })) || [];
    if (!Array.isArray(sessions)) sessions = [];
    if (Number.isFinite(since)) {
      sessions = sessions.filter((s) => Date.parse(s.lastMessageAt || s.startedAt || 0) >= since);
    }
    let crons = (await trpcQuery('cron.listForAgent', { agentName: target })) || [];
    if (!Array.isArray(crons)) crons = [];
    // Latest turn from the most-recent session.
    let latest = null;
    const recent = [...sessions].sort(
      (a, b) => Date.parse(b.lastMessageAt || b.startedAt || 0) - Date.parse(a.lastMessageAt || a.startedAt || 0),
    )[0];
    if (recent) {
      const msgs = (await trpcQuery('chat.listMessages', { sessionId: recent.id, limit: 16 })) || [];
      const arr = Array.isArray(msgs) ? msgs : [];
      const lastA = [...arr].reverse().find((m) => m.role === 'assistant' && textOf(m.content));
      const lastU = [...arr].reverse().find((m) => m.role === 'user' && textOf(m.content));
      latest = {
        sessionId: recent.id,
        lastUser: textOf(lastU?.content).slice(0, 600) || null,
        lastAssistant: textOf(lastA?.content).slice(0, 800) || null,
      };
    }
    return JSON.stringify({
      name: target,
      identity: (agent?.identityText || agent?.memorySummary || '').slice(0, 500) || null,
      skills: agent?.skillNames || [],
      sessions: sessions.map((s) => ({ id: s.id, title: s.title || s.preview || null, alive: s.alive, state: s.state, lastMessageAt: s.lastMessageAt })),
      crons: crons.map((c) => ({ id: c.id, title: c.title || String(c.prompt || '').slice(0, 40), intervalSec: c.intervalSec, enabled: c.enabled, lastStatus: c.lastStatus, lastFire: c.lastFire })),
      latest,
    });
  }
  if (name === 'dispatch') {
    const agentName = args?.agentName;
    const prompt = args?.prompt;
    if (typeof agentName !== 'string' || !agentName) throw new Error('agentName required');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt required');
    // Validate the target: a real, non-trashed, non-orchestrator agent on this
    // machine (also blocks the brain dispatching to itself).
    const agents = (await trpcQuery('agents.list', null)) || [];
    const target = (Array.isArray(agents) ? agents : []).find((a) => a.name === agentName);
    if (!target) throw new Error(`no agent named "${agentName}" on this machine (see roster)`);
    if (target.isOrchestrator) throw new Error('cannot dispatch to the orchestrator itself');
    const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 120) : undefined;
    if (args?.recurring && Number.isFinite(Number(args.recurring.intervalMinutes))) {
      const intervalMinutes = Number(args.recurring.intervalMinutes);
      if (intervalMinutes < 1) throw new Error('recurring.intervalMinutes must be ≥ 1');
      const jitterMinutes = Number.isFinite(Number(args.recurring.jitterMinutes)) ? Math.max(0, Number(args.recurring.jitterMinutes)) : 0;
      const res = await trpcMutate('cron.create', {
        agentName,
        prompt: prompt.trim(),
        intervalSec: Math.max(60, Math.round(intervalMinutes * 60)),
        jitterSec: Math.round(jitterMinutes * 60),
        ...(title ? { title } : {}),
      });
      const cron = res?.[0]?.result?.data?.json;
      return JSON.stringify({ ok: true, kind: 'recurring', agent: agentName, cronId: cron?.id ?? null });
    }
    // Reuse an existing idle dispatch session on this agent when the brain asked
    // for it AND it's valid (open dispatch session for this agent) — else open a
    // fresh one. Reuse keeps dispatch sessions (each a live claude process) from
    // piling up. Sessions are marked origin:'dispatch' so /brain/dispatch lists
    // them structurally (independent of the title; the title stays the caller's
    // label or the "Brain → <agent>" default).
    let sessionId = null;
    const reuseId = typeof args?.reuseSessionId === 'string' ? args.reuseSessionId.trim() : '';
    if (reuseId) {
      const all = (await trpcQuery('chat.listSessions', {})) || [];
      const reuse = (Array.isArray(all) ? all : []).find(
        (s) => s.id === reuseId && s.agentName === agentName && s.origin === 'dispatch' && !s.closedAt,
      );
      if (reuse) sessionId = reuse.id;
    }
    if (!sessionId) {
      const sres = await trpcMutate('chat.createSession', { agentName, title: title || `Brain → ${agentName}`, origin: 'dispatch' });
      const session = sres?.[0]?.result?.data?.json;
      if (!session?.id) throw new Error('failed to create a session on the target agent');
      sessionId = session.id;
    }
    await trpcMutate('chat.send', { sessionId, text: prompt.trim() });
    return JSON.stringify({ ok: true, kind: 'oneshot', agent: agentName, sessionId, reused: !!reuseId && sessionId === reuseId });
  }
  if (name === 'dispatch_result') {
    const sessionId = args?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId required');
    const waitMs = Math.min(Math.max(0, Number(args?.waitMs) || 0), 120_000);
    const deadline = Date.now() + waitMs;
    let msgs = [];
    // Poll: stop once the newest message is an assistant turn (a reply landed),
    // else keep checking until the wait window elapses.
    for (;;) {
      const got = (await trpcQuery('chat.listMessages', { sessionId, limit: 20 })) || [];
      msgs = Array.isArray(got) ? got : [];
      const last = msgs[msgs.length - 1];
      if ((last && last.role === 'assistant' && textOf(last.content)) || Date.now() >= deadline) break;
      await sleep(3000);
    }
    const lastA = [...msgs].reverse().find((m) => m.role === 'assistant' && textOf(m.content));
    const sessions = (await trpcQuery('chat.listSessions', {})) || [];
    const s = (Array.isArray(sessions) ? sessions : []).find((x) => x.id === sessionId);
    return JSON.stringify({
      sessionId,
      alive: s?.alive ?? null,
      state: s?.state ?? null,
      messageCount: msgs.length,
      lastAssistant: textOf(lastA?.content).slice(0, 2000) || null,
    });
  }
  if (name === 'dispatch_list') {
    const sessions = (await trpcQuery('chat.listSessions', {})) || [];
    const list = (Array.isArray(sessions) ? sessions : [])
      .filter((s) => s.origin === 'dispatch' && !s.closedAt)
      .sort((a, b) => new Date(b.lastMessageAt || b.startedAt).getTime() - new Date(a.lastMessageAt || a.startedAt).getTime())
      .map((s) => ({
        sessionId: s.id,
        agent: s.agentName,
        title: s.title || null,
        working: !!s.alive,
        lastActivity: s.lastMessageAt || s.startedAt || null,
      }));
    return JSON.stringify({ count: list.length, dispatches: list });
  }
  if (name === 'dispatch_close') {
    const sessionId = args?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId required');
    const sessions = (await trpcQuery('chat.listSessions', {})) || [];
    const s = (Array.isArray(sessions) ? sessions : []).find((x) => x.id === sessionId);
    if (!s) throw new Error('session not found');
    if (s.origin !== 'dispatch') throw new Error('not a dispatch session — dispatch_close only reaps dispatches');
    await trpcMutate('chat.deleteSession', { id: sessionId });
    return JSON.stringify({ ok: true, closed: sessionId, agent: s.agentName });
  }
  if (name === 'kb_list') {
    const bases = (await trpcQuery('knowledge.listBases', null)) || [];
    return JSON.stringify({ knowledgeBases: bases });
  }
  if (name === 'kb_read_docs') {
    const baseId = args?.baseId;
    if (typeof baseId !== 'string' || !baseId) throw new Error('baseId required');
    const kb = await trpcQuery('knowledge.baseDocs', { baseId });
    if (!kb) throw new Error('knowledge base not found');
    return JSON.stringify(kb);
  }
  if (name === 'kb_set_intro') {
    const baseId = args?.baseId;
    const intro = args?.intro;
    if (typeof baseId !== 'string' || !baseId) throw new Error('baseId required');
    if (typeof intro !== 'string') throw new Error('intro required');
    await trpcMutate('knowledge.setIntro', { id: baseId, intro });
    return JSON.stringify({ ok: true, baseId });
  }
  throw new Error(`unknown brain tool: ${name}`);
}

async function dispatchTool(name, args) {
  if (!SESSION_ID) throw new Error('HERMIT_SESSION_ID missing');
  if (BRAIN_TOOL_NAMES.has(name)) {
    if (!BRAIN) throw new Error('brain tools are only available to the orchestrator (Brain) session');
    return dispatchBrainTool(name, args);
  }
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
    if (up.kind && up.kind !== 'image') {
      throw new Error(`not an image: ${fp}. Use attach_file to send non-image files as downloads.`);
    }
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
  if (name === 'attach_file') {
    const fp = args?.filePath;
    if (typeof fp !== 'string' || !fp) throw new Error('filePath required');
    if (!fs.existsSync(fp)) throw new Error(`file not found: ${fp}`);
    const up = await uploadFile(fp);
    const fileName = typeof up.name === 'string' && up.name ? up.name : path.basename(fp);
    const blocks = [];
    if (typeof args?.caption === 'string' && args.caption.trim()) {
      blocks.push({ type: 'text', text: args.caption.trim() });
    }
    blocks.push({
      type: 'file',
      source: { type: 'url', url: up.url, media_type: up.mimeType || 'application/octet-stream' },
      name: fileName,
    });
    await postChatMessage([
      {
        sessionId: SESSION_ID,
        role: 'assistant',
        content: blocks,
        externalId: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    ]);
    return `ok — file attached (${fileName} → ${up.url})`;
  }
  if (name === 'cron_create') {
    const prompt = args?.prompt;
    const intervalMinutes = Number(args?.intervalMinutes);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt required');
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) throw new Error('intervalMinutes must be ≥ 1');
    const jitterMinutes = Number.isFinite(Number(args?.jitterMinutes)) ? Math.max(0, Number(args.jitterMinutes)) : 0;
    const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 120) : undefined;
    const res = await trpcMutate('cron.createFromSession', {
      sessionId: SESSION_ID,
      prompt: prompt.trim(),
      intervalSec: Math.round(intervalMinutes * 60),
      jitterSec: Math.round(jitterMinutes * 60),
      title,
    });
    const created = res?.[0]?.result?.data?.json;
    return `ok — cron scheduled: every ${intervalMinutes}m${jitterMinutes ? ` ±${jitterMinutes}m` : ''}${created?.id ? `, id ${created.id}` : ''}. Manage it on the dashboard /cron page.`;
  }
  if (name === 'cron_list') {
    const list = (await trpcQuery('cron.listForSession', { sessionId: SESSION_ID })) || [];
    if (!Array.isArray(list) || list.length === 0) return 'no crons for this agent yet.';
    const lines = list.map((c) => {
      const every = c.intervalSec % 3600 === 0 ? `${c.intervalSec / 3600}h` : `${Math.round(c.intervalSec / 60)}m`;
      const jit = c.jitterSec ? ` ±${Math.round(c.jitterSec / 60)}m` : '';
      const state = c.enabled ? (c.lastStatus || 'idle') : 'off';
      return `- ${c.id} · every ${every}${jit} · ${state} · ${c.title || String(c.prompt).slice(0, 40)}`;
    });
    return `crons for this agent:\n${lines.join('\n')}`;
  }
  if (name === 'cron_delete') {
    const id = args?.id;
    if (typeof id !== 'string' || !id) throw new Error('id required');
    await trpcMutate('cron.deleteFromSession', { sessionId: SESSION_ID, id });
    return `ok — cron ${id} deleted.`;
  }
  if (name === 'ask') {
    const question = args?.question;
    if (typeof question !== 'string' || !question.trim()) throw new Error('question required');
    const options = (Array.isArray(args?.options) ? args.options : [])
      .map((o) => (typeof o === 'string' ? { label: o } : o))
      .filter((o) => o && typeof o.label === 'string' && o.label.trim())
      .map((o) => ({
        label: String(o.label).slice(0, 200),
        ...(typeof o.description === 'string' && o.description.trim()
          ? { description: o.description.trim().slice(0, 500) }
          : {}),
      }))
      .slice(0, 12);
    if (options.length === 0) throw new Error('at least one option with a label is required');
    const multiSelect = !!args?.multiSelect;
    const { id } = await createInteraction({
      kind: 'question',
      payload: { question: question.trim(), options, multiSelect },
    });
    const answers = await waitForAnswer(id);
    if (answers == null) {
      return 'No answer — the question timed out (~4h) without a response. Proceed conservatively or ask again.';
    }
    if (answers.length === 0) return 'The user dismissed the question without choosing.';
    return `User answered: ${answers.map((a) => `"${a}"`).join(', ')}`;
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
      sendResult(id, { tools: BRAIN ? TOOLS.concat(BRAIN_TOOLS) : TOOLS });
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
