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
//       (the one mechanism for every repeating task — a run ends its own cron with a
//        lone CRON_DONE line, or re-paces it with CRON_NEXT <minutes>)
//   - cron_list()                     list this agent's crons
//   - cron_update(id, ...)            edit one IN PLACE (keeps its fire time)
//   - cron_delete(id)                 delete one of this agent's crons
//
// Talks JSON-RPC 2.0 over stdio per MCP spec — no SDK needed (the SDK pulls in
// too many deps for what is a 200-line transport).

'use strict';

const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
// Pure helpers live in a sibling // @ts-check'd module (type-checked + unit-tested
// in isolation; this stub is spawned by raw `node` so it stays outside the tsc gate).
const { mimeForExt, textOf, buildCronPatch, writeMemory } = require('./mcp-stub-util.cjs');

const SESSION_ID = process.env.HERMIT_SESSION_ID || '';
const DASHBOARD_URL = process.env.HERMIT_DASHBOARD_URL || 'http://127.0.0.1:4101';
const KEY = process.env.HERMIT_KEY || '';
// The orchestrator ("义脑") session is launched by chat-runner with HERMIT_BRAIN=1.
// Only then are the cross-agent brain tools (roster / agent_activity / dispatch /
// dispatch_result) registered + accepted — a normal agent never gets them.
const BRAIN = process.env.HERMIT_BRAIN === '1';
// A pure-chat session (HERMIT_CHAT_ONLY=1) may talk, look, and hand things to
// the user — it may not change anything. Most of this surface is already
// read-only or purely conversational; these three are not. They schedule work
// that fires LATER as a normal turn with a full tool surface, so leaving them
// on would route straight around the mode instead of respecting it.
//
// This is the only place a pure-chat rule is enforced once for every backend:
// claude-sdk, claude-tmux, codex, pi, omp and prime all mount this same stub.
// Everything else about the mode is per-backend, because every backend's write
// tools live inside its own CLI. cron_list stays — reading a schedule is fine.
const CHAT_ONLY = process.env.HERMIT_CHAT_ONLY === '1';
const CHAT_ONLY_DENIED = new Set(['cron_create', 'cron_update', 'cron_delete']);
// Where this agent lives, for memory_write. Only set on a pure-chat session,
// which is the only one that has that tool.
const AGENT_DIR = process.env.HERMIT_AGENT_DIR || '';

// The other half of pure chat: an agent that cannot record what it just worked
// out forgets the conversation the moment it ends, which would make the mode
// useless for exactly the thinking-out-loud it is meant for. So the session
// keeps ONE way to put bytes on disk, and it is deliberately narrow — memory
// paths only, markdown only, and no mode that can delete what is already there
// (append and prepend keep the old text; create refuses an existing file).
// The path gate itself is resolveMemoryPath in mcp-stub-util.cjs, tested there.
const CHAT_ONLY_TOOLS = [
  {
    name: 'memory_write',
    description:
      "Record something in THIS agent's own memory. In a pure-chat session this is the ONLY way to put anything on disk — there is no Write and no shell — so use it exactly as you would have used Write: the daily log (memory/YYYY-MM-DD.md), a topic note (memory/notes/<slug>.md), its one-line index entry (memory/notes/INDEX.md), MEMORY.md, or evolution/lessons.md. `path` is relative to the agent's directory and must be markdown under memory/ or evolution/, or MEMORY.md. `mode` is append (default, adds at the end), prepend (inserts at the top — this is how INDEX.md takes a new line), or create (new file; fails if it already exists). Nothing here can delete or overwrite existing text, so when in doubt append.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Relative to the agent directory, e.g. 'memory/2026-09-01.md'." },
        content: { type: 'string', description: 'The markdown to write. Include your own blank lines and heading.' },
        mode: { type: 'string', enum: ['append', 'prepend', 'create'], description: 'Default append.' },
      },
      required: ['path', 'content'],
    },
  },
];
const CHAT_ONLY_TOOL_NAMES = new Set(CHAT_ONLY_TOOLS.map((t) => t.name));

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
  const mt = mimeForExt(ext);
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
      "Schedule a durable repeating task for THIS agent — this is the ONE mechanism for all of them, whether the user called it a 定时任务, a routine, or a 循环 (there is no separate loop skill). Every intervalMinutes (± jitterMinutes of random float), the gateway runs `prompt` as a fresh claude turn in this agent's directory — an ISOLATED turn, so a daily job never grows this conversation's context — then posts its result back into THIS chat as a report and records it on the dashboard /cron page. It survives restarts. Because the result lands in the chat, write `prompt` so its final message IS the report you want to read: lead with the outcome, not with what you are about to do. A run can also decide the schedule: ending its reply with a line containing exactly CRON_DONE stops the cron for good (this is how a task that iterates toward a goal finishes itself — put the finish line and that instruction in `prompt`), and a line containing exactly CRON_NEXT <minutes> re-paces it. An isolated run remembers nothing, so a task whose rounds build on each other must keep its progress in a file the prompt names.",
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
    name: 'cron_update',
    description:
      "Edit one of THIS agent's existing cron tasks IN PLACE (get the id from cron_list); pass only the fields that change. ALWAYS prefer this over cron_delete + cron_create when the schedule already exists: editing the prompt keeps the cron's PHASE, so a report that fires at 09:00 goes on firing at 09:00 — delete+recreate resets the next fire to now and silently moves the job to whatever time you happened to rewrite it. intervalMinutes is the only field that reschedules (from the last run). Use for: rewriting a cron's prompt after improving the task, renaming it, retiming it, or pausing it with enabled=false instead of deleting it.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The cron id (from cron_list).' },
        prompt: { type: 'string', description: 'Replace the task prompt that runs on each fire.' },
        title: { type: 'string', description: 'Replace the short label shown in the cron list.' },
        intervalMinutes: {
          type: 'number',
          description: 'Change the interval, in minutes (minimum 1). The ONLY field that moves the next fire — it is recomputed from the last run.',
        },
        jitterMinutes: { type: 'number', description: 'Change the ± random float on the fire time, in minutes.' },
        enabled: { type: 'boolean', description: 'false pauses the cron (kept, not deleted); true resumes it.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'cron_delete',
    description:
      "Delete one of THIS agent's cron tasks by id (get the id from cron_list). Use when the user asks to stop / remove a scheduled task — to CHANGE one, use cron_update instead, and to pause one, cron_update with enabled=false.",
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
      "Inspect ONE agent: its identity/role summary, skills, recent chat sessions (+ the latest turn's text) and crons. Use it to understand what an agent does and what it has been doing — before routing work to it, or when writing your digest. Optional `since` (ISO timestamp) limits sessions to those active after it (incremental digests). Sessions the human moved to the recycle bin inside the window are listed separately as `trashedSessions` (with trashReason) — activity that was handled and discarded, NOT silence; without them a conversation the human answered and then deleted would look like it never happened. A session's recency is its `lastMessageAt` — the time of its last real message.",
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
    name: 'dispatch_answer',
    description:
      "Answer the choice an agent is BLOCKED on — the `blocked` a dispatch_result / dispatch_list / [takeover update] surfaced (a permission the agent wants, or an AskUserQuestion). Works for a dispatch AND for a conversation you're driving via takeover. Resolves it so the target continues. For a PERMISSION block pass approve:true|false (+ optional reason). For a QUESTION block pass answer (an option label, free text, or an array of labels for multi-select). SAFETY: only answer what you can decide SAFELY from the task's own context; for anything destructive, irreversible, spending money, or that you're unsure about, do NOT answer — leave it and tell the human instead.",
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The blocked session (dispatch or takeover) — its oldest pending choice is the one answered.' },
        approve: { type: 'boolean', description: 'PERMISSION block only: true = allow, false = deny.' },
        answer: { description: 'QUESTION block only: the answer — an option label, free text, or an array of labels for multi-select.' },
        reason: { type: 'string', description: 'Optional note — the permission reason / your rationale.' },
      },
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
  // ── Takeover: driving a conversation the human handed you ──────────────────
  // Distinct from dispatch. A dispatch is work YOU started on a worker; a takeover
  // is a conversation the HUMAN was already having and asked you to carry on. Their
  // earlier messages are the brief — read them before you say anything.
  {
    name: 'takeover_list',
    description:
      "The conversations the human has handed you to drive. Each is { sessionId, agentName, title, goal, turns, turnCap, working }. Check it when you get a [takeover update] you don't have context for, and to see how many messages you have left before a takeover is handed back automatically.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'takeover_read',
    description:
      "Read a conversation you're driving. Returns its messages with `authoredBy` on each: null = the HUMAN typed it (their intent — this is the brief), 'brain' = you said it earlier in this takeover. Call this FIRST after being handed a conversation, to work out what it's trying to achieve, and again after each [takeover update] to see what the agent replied.",
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'A sessionId from takeover_list or the [takeover] poke.' },
        limit: { type: 'number', description: 'How many recent messages (default 40, max 100).' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'takeover_say',
    description:
      "Say something to the agent in a conversation you're driving — as yourself, on the human's behalf. The human WATCHES it land: your text appears ghosted in their composer for a few seconds before it sends, which is also their window to take the conversation back — so this call pauses briefly, and that pause is the feature, not a stall. On your FIRST message you MUST pass `goal`: the thing you read the conversation as trying to achieve. It is shown to the human immediately, so a wrong reading gets corrected in seconds instead of after a dozen messages. Each call spends one of your turns; when they run out the takeover is handed back automatically, so don't chat — advance the work.",
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'A sessionId from takeover_list or the [takeover] poke.' },
        text: { type: 'string', description: 'What to say to the agent.' },
        goal: { type: 'string', description: 'REQUIRED on your first message: what this conversation is trying to achieve, in one line.' },
      },
      required: ['sessionId', 'text'],
    },
  },
  {
    name: 'takeover_release',
    description:
      "Hand a conversation back to the human, with a short summary of what happened while you drove it. Call it the moment the goal is met — and also the moment you're stuck, unsure, or facing anything destructive / irreversible / costly. Releasing early is always correct; there is no credit for using all your turns.",
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The conversation to hand back.' },
        summary: { type: 'string', description: 'One or two lines: what you did, where it stands, anything the human should pick up.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'cleanup_sessions',
    description:
      "Tidy this machine's chat sessions: archive the ones nobody has touched in a long time. Archiving takes a conversation out of the human's sidebar AND puts its ~500MB claude to sleep. Run it in your daily dream. It CANNOT delete anything — archiving undoes in one click, and the recycle bin is only ever reachable from the human's own confirmation. A session is skipped when anything still points at it: a cron reporting in, a pending question, a queued message, a live dispatch, a group, a name the human typed. Pass `preview` to see what it WOULD do without doing it. How to read the numbers: a session's idle age runs from its last real message (`lastMessageAt`); `total` counts ALL non-binned sessions INCLUDING already-archived ones, so it grows until the human empties the bin — watch `open` instead; and when the machine has an idle threshold set (`autoSweep.idleDays`), the gateway itself archives on a ~10-minute tick, so `archived: 0` from YOUR call normally means the sweep beat you to it, not that nothing ages.",
    inputSchema: {
      type: 'object',
      properties: {
        preview: { type: 'boolean', description: 'true = report only, change nothing.' },
        archiveIdleDays: { type: 'number', description: "Archive threshold in days. Omit for the machine's setting (default 14)." },
      },
    },
  },
  {
    name: 'user_messages',
    description:
      "Read what the HUMAN has actually typed across this machine's conversations, oldest first — the raw material for USER-PROFILE.md. Only their own messages: your takeover messages and the gateway's [dispatch update] pokes are excluded, so you can never mistake your own voice for theirs. Pass `since` (the synced-through watermark at the bottom of USER-PROFILE.md) to get only what's new; omit it for a first pass.",
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: "ISO timestamp — the watermark from USER-PROFILE.md. Omit on a first pass." },
        limit: { type: 'number', description: 'How many messages (default 200, max 400).' },
      },
    },
  },
];
const BRAIN_TOOL_NAMES = new Set(BRAIN_TOOLS.map((t) => t.name));

// The choice a dispatch target is BLOCKED on (its oldest pending interaction),
// shaped so the Brain can answer it with dispatch_answer — or null when it isn't
// blocked. A pending interaction means the agent's turn is parked waiting for a
// decision (its pane still reads "working", so this is the ONLY way to tell a
// blocked dispatch from a busy one). permission payload = { tool, input, ... };
// question payload = { question, options[], multiSelect }.
async function blockedOn(sessionId) {
  let pend;
  try {
    pend = await trpcQuery('interaction.listPending', { sessionId });
  } catch {
    return null;
  }
  const p = Array.isArray(pend) ? pend[0] : null;
  if (!p) return null;
  const pl = p.payload || {};
  if (p.kind === 'permission') {
    const inp = pl.input ? ' ' + JSON.stringify(pl.input).slice(0, 200) : '';
    return {
      interactionId: p.id,
      kind: 'permission',
      ask: `wants to run tool "${pl.tool || '?'}"${inp}`,
      answerWith: 'dispatch_answer({ sessionId, approve: true|false, reason? })',
    };
  }
  const options = Array.isArray(pl.options)
    ? pl.options.map((o) => (typeof o === 'string' ? o : o && o.label)).filter(Boolean).slice(0, 12)
    : [];
  return {
    interactionId: p.id,
    kind: 'question',
    ask: String(pl.question || '').slice(0, 600),
    options,
    multiSelect: !!pl.multiSelect,
    answerWith: 'dispatch_answer({ sessionId, answer })',
  };
}

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
    // Recycle-binned sessions are invisible to listSessions (LIVE_SESSION filter),
    // but they still HAD activity inside the window — the human answered pdp-copy
    // questions all morning, deleted the chat after lunch, and the digest read as
    // "nobody spoke" (observed 2026-08-17). Surface them separately so a handled-
    // and-discarded conversation is never mistaken for silence. The Brain's own
    // dispatch reaps ('dispatch-done') are excluded — it already knows about those.
    let binned = [];
    try {
      const bin = await trpcQuery('chat.listTrashed', null);
      binned = (Array.isArray(bin?.rows) ? bin.rows : [])
        .filter((s) => s.agentName === target && s.trashReason !== 'dispatch-done')
        .filter((s) => !Number.isFinite(since) || Date.parse(s.lastMessageAt || s.trashedAt || 0) >= since)
        .sort((a, b) => Date.parse(b.trashedAt || 0) - Date.parse(a.trashedAt || 0))
        .slice(0, 20);
    } catch {
      // bin unreadable → report live sessions only, as before
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
      ...(binned.length > 0
        ? {
            trashedSessions: binned.map((s) => ({
              id: s.id,
              title: s.title || s.preview || null,
              lastMessageAt: s.lastMessageAt,
              trashedAt: s.trashedAt,
              trashReason: s.trashReason,
            })),
          }
        : {}),
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
    let reused = false;
    const reuseId = typeof args?.reuseSessionId === 'string' ? args.reuseSessionId.trim() : '';
    if (reuseId) {
      const all = (await trpcQuery('chat.listSessions', {})) || [];
      const reuse = (Array.isArray(all) ? all : []).find(
        (s) => s.id === reuseId && s.agentName === agentName && s.origin === 'dispatch' && !s.closedAt,
      );
      if (reuse) {
        sessionId = reuse.id;
        reused = true;
        // Re-point the reused session at THIS brain session, so the dispatch-watcher
        // pokes the current dispatcher on finish/block (not whoever first opened it).
        if (SESSION_ID) await trpcMutate('chat.setDispatchOrigin', { id: sessionId, dispatchedBySessionId: SESSION_ID });
      }
    }
    if (!sessionId) {
      const sres = await trpcMutate('chat.createSession', {
        agentName,
        title: title || `Brain → ${agentName}`,
        origin: 'dispatch',
        // stamp the dispatcher so the gateway can poke it back (Phase 2 routing)
        ...(SESSION_ID ? { dispatchedBySessionId: SESSION_ID } : {}),
      });
      const session = sres?.[0]?.result?.data?.json;
      if (!session?.id) throw new Error('failed to create a session on the target agent');
      sessionId = session.id;
    }
    await trpcMutate('chat.send', { sessionId, text: prompt.trim() });
    return JSON.stringify({ ok: true, kind: 'oneshot', agent: agentName, sessionId, reused });
  }
  if (name === 'dispatch_result') {
    const sessionId = args?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId required');
    const waitMs = Math.min(Math.max(0, Number(args?.waitMs) || 0), 120_000);
    const deadline = Date.now() + waitMs;
    let msgs = [];
    let blocked = null;
    // Settle once a reply landed OR the target is BLOCKED on a choice (a pending
    // interaction — it can't progress until someone answers), else keep checking
    // until the wait window elapses.
    for (;;) {
      blocked = await blockedOn(sessionId);
      const got = (await trpcQuery('chat.listMessages', { sessionId, limit: 20 })) || [];
      msgs = Array.isArray(got) ? got : [];
      const last = msgs[msgs.length - 1];
      const settled = !!blocked || (last && last.role === 'assistant' && textOf(last.content));
      if (settled || Date.now() >= deadline) break;
      await sleep(3000);
    }
    const lastA = [...msgs].reverse().find((m) => m.role === 'assistant' && textOf(m.content));
    const sessions = (await trpcQuery('chat.listSessions', {})) || [];
    const s = (Array.isArray(sessions) ? sessions : []).find((x) => x.id === sessionId);
    return JSON.stringify({
      sessionId,
      alive: s?.alive ?? null,
      state: s?.state ?? null,
      // real progress: working only when genuinely working AND not parked on a
      // choice; blocked → answer it (dispatch_answer) or escalate to the human.
      working: s?.state === 'working' && !blocked,
      blocked,
      messageCount: msgs.length,
      lastAssistant: textOf(lastA?.content).slice(0, 2000) || null,
    });
  }
  if (name === 'dispatch_list') {
    const sessions = (await trpcQuery('chat.listSessions', {})) || [];
    const open = (Array.isArray(sessions) ? sessions : [])
      .filter((s) => s.origin === 'dispatch' && !s.closedAt)
      .sort((a, b) => new Date(b.lastMessageAt || b.startedAt).getTime() - new Date(a.lastMessageAt || a.startedAt).getTime());
    // Per session: real working (from state, not just process-alive) + whether it's
    // parked on a choice. The list is short by design, so the extra checks are cheap.
    const dispatches = await Promise.all(
      open.map(async (s) => {
        const blocked = await blockedOn(s.id);
        return {
          sessionId: s.id,
          agent: s.agentName,
          title: s.title || null,
          working: s.state === 'working' && !blocked,
          blocked: blocked || undefined,
          lastActivity: s.lastMessageAt || s.startedAt || null,
        };
      }),
    );
    return JSON.stringify({ count: dispatches.length, dispatches });
  }
  if (name === 'dispatch_close') {
    const sessionId = args?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId required');
    const sessions = (await trpcQuery('chat.listSessions', {})) || [];
    const s = (Array.isArray(sessions) ? sessions : []).find((x) => x.id === sessionId);
    if (!s) throw new Error('session not found');
    if (s.origin !== 'dispatch') throw new Error('not a dispatch session — dispatch_close only reaps dispatches');
    // Recycle bin, NOT chat.deleteSession. This tool's whole promise is "frees the
    // worker's idle claude process", and the delete path did the opposite: it drops
    // the row, and every pane-killing path is driven by that row, so the process was
    // stranded with nothing able to reap it. The Brain closes dispatches every dream,
    // which made this a daily orphan factory. Trashing hibernates the pane first and
    // keeps the conversation recoverable until it is purged.
    // See docs/session-cleanup-design.md.
    await trpcMutate('chat.trashSessions', { ids: [sessionId], reason: 'dispatch-done' });
    return JSON.stringify({ ok: true, closed: sessionId, agent: s.agentName });
  }
  if (name === 'cleanup_sessions') {
    const archiveIdleDays = Number.isFinite(Number(args?.archiveIdleDays)) && Number(args.archiveIdleDays) > 0
      ? Math.round(Number(args.archiveIdleDays))
      : undefined;
    const input = archiveIdleDays ? { archiveIdleDays } : {};
    // The machine's own settings, so the reply can say WHO archives here. When
    // cleanupIdleDays is set, the gateway's cleanup-sweep tick (~10 min) archives
    // continuously — a daily Brain run then correctly finds nothing left, and
    // without this context four straight `archived: 0`s read as a dead tool
    // (observed 2026-08-14 → 08-17).
    const cfg = await trpcQuery('chat.cleanupConfig', null).catch(() => null);
    const sweepDays = cfg?.cleanupIdleDays ?? null;
    const autoSweep = sweepDays != null
      ? { idleDays: sweepDays, note: `the gateway auto-archives sessions idle ≥${sweepDays}d on a ~10-minute tick; this call is a backstop` }
      : { idleDays: null, note: 'no machine threshold set — only manual or Brain-run cleanups archive here' };
    if (args?.preview) {
      const p = (await trpcQuery('chat.cleanupPreview', input)) || {};
      // `archived` (already-archived count) needs a dashboard that returns it;
      // omit the derived fields rather than guess when talking to an older one.
      const open = p.total != null && p.archived != null ? p.total - p.archived : undefined;
      return JSON.stringify({
        preview: true,
        // total counts every non-binned session INCLUDING archived ones — it only
        // shrinks when the human empties the bin. `open` is what the sidebar shows.
        total: p.total,
        ...(open != null ? { open, alreadyArchived: p.archived } : {}),
        ...(p.trashed != null ? { inBin: p.trashed } : {}),
        wouldArchive: (p.archive || []).length,
        // Reported but NOT actionable from here: only the human's own confirmation
        // can move anything into the bin.
        proposedForBin: (p.trash || []).length,
        spared: (p.spared || []).length,
        autoSweep,
      });
    }
    // trpcMutate returns the raw tRPC batch envelope — unwrap it. (The old
    // `r.archived` read the envelope itself, so apply reported `archived: 0`
    // no matter what it did.)
    const res = await trpcMutate('chat.cleanupApply', input);
    const applied = res?.[0]?.result?.data?.json || {};
    return JSON.stringify({ ok: true, archived: applied.archived ?? 0, autoSweep });
  }
  if (name === 'dispatch_answer') {
    const sessionId = args?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId required');
    // Confirm it's one of the brain's own dispatch sessions before touching it.
    const sessions = (await trpcQuery('chat.listSessions', {})) || [];
    const s = (Array.isArray(sessions) ? sessions : []).find((x) => x.id === sessionId);
    if (!s) throw new Error('session not found');
    if (s.origin !== 'dispatch') throw new Error('not a dispatch session — dispatch_answer only answers dispatches');
    const pend = (await trpcQuery('interaction.listPending', { sessionId })) || [];
    const p = Array.isArray(pend) ? pend[0] : null;
    if (!p) throw new Error('that dispatch is not blocked on a choice right now (nothing to answer)');
    let decision;
    if (p.kind === 'permission') {
      if (typeof args?.approve !== 'boolean') throw new Error('this is a PERMISSION block — pass approve:true|false');
      decision = { behavior: args.approve ? 'allow' : 'deny', ...(args?.reason ? { reason: String(args.reason).slice(0, 2000) } : {}) };
    } else {
      const a = args?.answer;
      const answers = Array.isArray(a)
        ? a.map(String)
        : a != null && String(a).trim()
          ? [String(a)]
          : null;
      if (!answers || answers.length === 0) throw new Error('this is a QUESTION block — pass answer (an option label, free text, or an array)');
      decision = { answers: answers.map((x) => x.slice(0, 4000)) };
    }
    // answeredBy stamps the card: a choice the Brain made for the human must not
    // look like one the human made.
    await trpcMutate('interaction.resolve', { id: p.id, decision, answeredBy: 'brain' });
    return JSON.stringify({ ok: true, sessionId, agent: s.agentName, kind: p.kind, decision });
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

  // ── Takeover ───────────────────────────────────────────────────────────────
  if (name === 'takeover_list') {
    const rows = (await trpcQuery('chat.listTakeovers', null)) || [];
    return JSON.stringify({
      takeovers: (Array.isArray(rows) ? rows : []).map((r) => ({
        sessionId: r.id,
        agentName: r.agentName,
        title: r.title,
        goal: r.takeoverGoal,
        turns: r.takeoverTurns,
        turnCap: r.turnCap,
        working: r.state === 'working',
      })),
    });
  }
  if (name === 'takeover_read') {
    const sessionId = args?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId required');
    const limit = Math.min(Math.max(1, Number(args?.limit) || 40), 100);
    const msgs = (await trpcQuery('chat.listMessages', { sessionId, limit })) || [];
    // authoredBy is the whole point of this readout: without it the Brain cannot
    // tell the human's intent from its own earlier messages in the same thread.
    return JSON.stringify({
      sessionId,
      messages: (Array.isArray(msgs) ? msgs : []).map((m) => ({
        role: m.role,
        authoredBy: m.authoredBy ?? null,
        who: m.role === 'user' ? (m.authoredBy === 'brain' ? 'you' : m.authoredBy === 'system' ? 'system' : 'human') : m.role,
        text: textOf(m.content).slice(0, 4000),
        at: m.createdAt,
      })),
    });
  }
  if (name === 'takeover_say') {
    const sessionId = args?.sessionId;
    const text = args?.text;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId required');
    if (typeof text !== 'string' || !text.trim()) throw new Error('text required');
    const goal = typeof args?.goal === 'string' && args.goal.trim() ? args.goal.trim() : undefined;
    // The cap lives server-side; an over-cap send is REFUSED there and the takeover
    // is handed back, so a rejection here is the system working, not a fault to retry.
    const body = text.trim();
    // Show the sentence being written before it lands. The human sees it ghosted in
    // the composer, which is both the point (they watch you work rather than finding
    // a message that appeared) and their window to take the wheel back first.
    // Best-effort: never let the decoration stop the message.
    try {
      await trpcMutate('chat.setTakeoverDraft', { sessionId, text: body });
      // Roughly reading speed, floored so a one-liner still registers and capped so a
      // long message doesn't stall the turn.
      await sleep(Math.min(6000, 1200 + body.length * 25));
    } catch (e) {
      // draft is cosmetic — carry on
    }
    await trpcMutate('chat.send', { sessionId, text: body, authoredBy: 'brain', ...(goal ? { goal } : {}) });
    return JSON.stringify({ ok: true, sessionId });
  }
  if (name === 'takeover_release') {
    const sessionId = args?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId required');
    const summary = typeof args?.summary === 'string' ? args.summary.slice(0, 500) : undefined;
    const r = await trpcMutate('chat.releaseTakeover', {
      sessionId,
      reason: 'done',
      ...(summary ? { summary } : {}),
    });
    return JSON.stringify(r?.[0]?.result?.data?.json ?? { ok: true, sessionId });
  }
  if (name === 'user_messages') {
    const since = typeof args?.since === 'string' && args.since.trim() ? args.since.trim() : null;
    const limit = Math.min(Math.max(1, Number(args?.limit) || 200), 400);
    const rows = (await trpcQuery('chat.humanMessages', { since, limit })) || [];
    const list = Array.isArray(rows) ? rows : [];
    return JSON.stringify({
      count: list.length,
      // The watermark to write back into USER-PROFILE.md — the last row's timestamp, so the
      // next pass resumes exactly here. Null when nothing new came back, which is
      // the signal to leave the existing watermark alone.
      syncedThrough: list.length ? list[list.length - 1].at : null,
      messages: list,
    });
  }
  throw new Error(`unknown brain tool: ${name}`);
}

/**
 * memory_write. The path gate (resolveMemoryPath) has already rejected anything
 * outside memory/, anything non-markdown and every spelling of `..`; what is
 * left for this function is the part that needs the filesystem — a symlink
 * inside the agent directory pointing out of it — plus the write itself.
 */
async function dispatchChatOnlyTool(name, args) {
  if (name !== 'memory_write') throw new Error(`unknown pure-chat tool: ${name}`);
  return writeMemory(AGENT_DIR, args);
}

async function dispatchTool(name, args) {
  if (!SESSION_ID) throw new Error('HERMIT_SESSION_ID missing');
  // Belt and braces, exactly as the brain tools do below: not listing a tool
  // and refusing to run it are two different defences, and a resumed child may
  // still hold a tool table from before the flag was set.
  if (CHAT_ONLY && CHAT_ONLY_DENIED.has(name)) {
    throw new Error(
      `${name} is unavailable in a pure-chat session: it would schedule work that later runs with a full tool surface. Tell the user this needs an ordinary session.`,
    );
  }
  if (BRAIN_TOOL_NAMES.has(name)) {
    if (!BRAIN) throw new Error('brain tools are only available to the orchestrator (Brain) session');
    return dispatchBrainTool(name, args);
  }
  if (CHAT_ONLY_TOOL_NAMES.has(name)) {
    if (!CHAT_ONLY) throw new Error(`${name} exists only in a pure-chat session; use Write or Edit instead`);
    return dispatchChatOnlyTool(name, args);
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
    return `ok — cron scheduled: every ${intervalMinutes}m${jitterMinutes ? ` ±${jitterMinutes}m` : ''}${created?.id ? `, id ${created.id}` : ''}. Each run reports back into THIS conversation; full history on the dashboard /cron page.`;
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
  if (name === 'cron_update') {
    const id = args?.id;
    if (typeof id !== 'string' || !id) throw new Error('id required');
    const patch = buildCronPatch(args); // throws on an empty / malformed patch
    const changed = Object.keys(patch);
    const res = await trpcMutate('cron.updateFromSession', { sessionId: SESSION_ID, id, ...patch });
    const saved = res?.[0]?.result?.data?.json;
    // Report the fire time back either way: the whole reason to edit in place is that
    // the phase survives, and that is the one thing the caller cannot see from here.
    const next = saved?.nextFire ? String(saved.nextFire).slice(0, 16).replace('T', ' ') : null;
    const phase = patch.intervalSec != null
      ? `Interval changed, so the next fire was recomputed from the last run${next ? ` → ${next}` : ''}.`
      : `Next fire unchanged${next ? ` (${next})` : ''} — the schedule keeps its phase.`;
    return `ok — cron ${id} updated (${changed.join(', ')}). ${phase}`;
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
      // No HERMIT_SESSION_ID means this stub was NOT spawned for a hermit
      // session — the kimi-code backend declares this server in the shared
      // ~/.kimi-code/mcp.json, so the human's own interactive `kimi` runs load
      // it too. Those get a connected server with ZERO tools rather than a
      // startup failure or a list of tools that can only 404: invisible where
      // it does not belong, functional where it does.
      if (!SESSION_ID) {
        sendResult(id, { tools: [] });
        return;
      }
      const listed = BRAIN ? TOOLS.concat(BRAIN_TOOLS) : TOOLS;
      sendResult(id, {
        tools: CHAT_ONLY
          ? listed.filter((t) => !CHAT_ONLY_DENIED.has(t.name)).concat(CHAT_ONLY_TOOLS)
          : listed,
      });
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
