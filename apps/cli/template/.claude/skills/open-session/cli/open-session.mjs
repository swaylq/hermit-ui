#!/usr/bin/env node
// open-session.mjs — open a new chat session in the hermit dashboard, for the
// current agent or any other agent on this machine. See SKILL.md next to this dir.
//
//   node open-session.mjs                          # blank session for the current agent
//   node open-session.mjs -a scribe -t "周报" -m "整理一下本周的发布记录"
//   node open-session.mjs --list-agents
//
// The machine key is read from $HERMIT_KEY / $ASST_KEY / the macOS keychain and
// is NEVER printed and never placed on a command line.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const USAGE = `open-session — open a new chat session in the hermit dashboard

  node open-session.mjs [options]

  -a, --agent <name>        target agent (default: the agent this session belongs to)
  -t, --title <text>        session title, ≤120 chars (omit → auto-titled after first messages)
  -m, --message <text>      first message — wakes the session; the agent starts working on it
  -f, --message-file <path> read the first message from a file (long / multiline prompts)
  -l, --list-agents         print this machine's agents and exit
      --json                machine-readable output
      --runtime <r>             advanced: claude-tmux | pi-rpc | codex-exec | dsh-exec
      --runtime-provider <p>    advanced: pi provider override
      --runtime-model <m>       advanced: model override
      --runtime-mode <mode>     advanced: pi mode override

Blank session (no -m): appears in the dashboard sidebar, costs nothing until
someone sends the first message. With -m: the gateway wakes it immediately.`;

const DASH = (process.env.HERMIT_DASHBOARD_URL || process.env.DASHBOARD_URL || '{{DASHBOARD_URL}}').replace(/\/+$/, '');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function resolveKey() {
  if (process.env.HERMIT_KEY) return process.env.HERMIT_KEY;
  if (process.env.ASST_KEY) return process.env.ASST_KEY;
  if (process.platform === 'darwin') {
    try {
      return execFileSync(
        'security',
        ['find-generic-password', '-a', 'asst', '-s', 'asst-gateway-vps-key', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    } catch {
      /* fall through */
    }
  }
  return '';
}

const KEY = resolveKey();
if (!KEY) fail('no machine key: set HERMIT_KEY or ASST_KEY (or keychain item asst-gateway-vps-key on macOS)');

// Same wire format as the gateway's mcp-stub: tRPC batch=1, superjson-plain
// input under {0:{json:...}}, result under [0].result.data.json.
async function trpc(method, procedure, input) {
  const enc = JSON.stringify({ 0: { json: input } });
  const url = method === 'GET'
    ? `${DASH}/api/trpc/${procedure}?batch=1&input=${encodeURIComponent(enc)}`
    : `${DASH}/api/trpc/${procedure}?batch=1`;
  const r = await fetch(url, {
    method,
    headers: { 'x-asst-key': KEY, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: enc } : {}),
  }).catch((e) => fail(`cannot reach dashboard at ${DASH}: ${e.message}`));
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    fail(`${procedure} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  const item = Array.isArray(j) ? j[0] : j;
  if (!r.ok || item?.error) fail(`${procedure} → ${item?.error?.json?.message || `HTTP ${r.status}`}`);
  return item?.result?.data?.json;
}
const query = (p, i = null) => trpc('GET', p, i);
const mutate = (p, i) => trpc('POST', p, i);

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { runtimeKeys: {} };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    if (++i >= argv.length) fail(`${a} needs a value`);
    return argv[i];
  };
  if (a === '--agent' || a === '-a') opts.agent = next();
  else if (a === '--title' || a === '-t') opts.title = next();
  else if (a === '--message' || a === '-m') opts.message = next();
  else if (a === '--message-file' || a === '-f') opts.messageFile = next();
  else if (a === '--runtime') opts.runtimeKeys.runtime = next();
  else if (a === '--runtime-provider') opts.runtimeKeys.runtimeProvider = next();
  else if (a === '--runtime-model') opts.runtimeKeys.runtimeModel = next();
  else if (a === '--runtime-mode') opts.runtimeKeys.runtimeMode = next();
  else if (a === '--list-agents' || a === '-l') opts.list = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--help' || a === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else fail(`unknown arg: ${a} (see --help)`);
}

const agents = await query('agents.list');
if (!Array.isArray(agents) || agents.length === 0) fail('dashboard returned no agents for this machine');

if (opts.list) {
  for (const a of agents) console.log(`${a.name}${a.isOrchestrator ? '  [orchestrator]' : ''}`);
  process.exit(0);
}

// ── resolve target agent ────────────────────────────────────────────────────
let target;
if (opts.agent) {
  target = agents.find((a) => a.name === opts.agent);
  if (!target) fail(`no agent named "${opts.agent}" on this machine.\n  agents: ${agents.map((a) => a.name).join(', ')}`);
} else {
  // "current agent": the session this script runs inside, else cwd ∈ agent dir.
  const sid = process.env.HERMIT_SESSION_ID || '';
  if (sid) {
    const sessions = (await query('chat.listSessions', {})) || [];
    const mine = sessions.find((s) => s.id === sid);
    if (mine) target = agents.find((a) => a.name === mine.agentName);
  }
  if (!target) {
    const cwd = process.cwd();
    target = agents
      .filter((a) => a.directory && (cwd === a.directory || cwd.startsWith(a.directory + '/')))
      .sort((x, y) => y.directory.length - x.directory.length)[0];
  }
  if (!target) fail('cannot tell which agent is "current" (no HERMIT_SESSION_ID, cwd not inside an agent directory) — pass --agent <name>');
}

// ── first message / title ───────────────────────────────────────────────────
let message = opts.message ?? null;
if (opts.messageFile) {
  if (message != null) fail('--message and --message-file are mutually exclusive');
  try {
    message = fs.readFileSync(opts.messageFile, 'utf8');
  } catch (e) {
    fail(`cannot read --message-file: ${e.message}`);
  }
}
if (message != null) {
  message = message.trim();
  if (!message) fail('first message is empty');
  if (message.length > 64000) fail(`first message too long (${message.length} > 64000 chars)`);
}
const title = (opts.title ?? '').trim() || undefined;
if (title && title.length > 120) fail('title too long (>120 chars)');

// ── create (+ optionally wake) ──────────────────────────────────────────────
const created = await mutate('chat.createSession', {
  agentName: target.name,
  ...(title ? { title } : {}),
  origin: 'agent', // provenance: opened by an agent, not the browser composer
  ...opts.runtimeKeys,
});
if (!created?.id) fail(`createSession returned no id: ${JSON.stringify(created).slice(0, 200)}`);

let sent = false;
if (message) {
  await mutate('chat.send', { sessionId: created.id, text: message });
  sent = true;
}

const url = `${DASH}${target.isOrchestrator ? '/brain' : '/chat'}?session=${encodeURIComponent(created.id)}`;
if (opts.json) {
  console.log(JSON.stringify({ ok: true, agent: target.name, sessionId: created.id, url, firstMessageSent: sent }));
} else {
  console.log(`✓ new session opened for ${target.name}`);
  console.log(`  session: ${created.id}`);
  console.log(`  url:     ${url}`);
  console.log(
    sent
      ? '  first message queued — the session is waking up and will start on it'
      : '  blank session — sleeps (no process) until someone sends the first message',
  );
}
