#!/usr/bin/env node
// Move agents' DEFAULT backend from claude-tmux to claude-sdk.
//
// The code migration (docs/claude-sdk-runtime-design.md) made claude-sdk the
// fleet default for anything with no stored preference. Existing agents DO have
// one — 'claude-tmux', written before the SDK backend existed — so nothing moves
// until this runs. That is deliberate: the deploy was designed to change no
// running conversation, and this is the separate, reviewable step that does.
//
// What changes, and what does not:
//
//   • An agent's default decides what NEW chats open on, and what an existing
//     session INHERITS when it stated no backend of its own.
//   • A session that pinned its own backend keeps it. Those need the per-session
//     picker (or --sessions below), not this.
//   • A session mid-turn refuses the switch; it moves on its next message.
//
// Nothing is lost either way. Both drivers write the same
// `~/.claude/projects/<cwd>/<uuid>.jsonl`, so the incoming one resumes the
// transcript the outgoing one wrote — verified end-to-end against the live
// stack, not just asserted. Moving back is the same operation with the argument
// reversed.
//
// Usage:
//   node scripts/migrate-agents-to-claude-sdk.mjs                 # dry run (default)
//   node scripts/migrate-agents-to-claude-sdk.mjs --apply
//   node scripts/migrate-agents-to-claude-sdk.mjs --apply --only asst,research
//   node scripts/migrate-agents-to-claude-sdk.mjs --apply --to claude-tmux   # roll back

import { execSync } from 'node:child_process';

const DASH = process.env.HERMIT_DASHBOARD_URL || 'https://dash.swaylab.ai';
function machineKey() {
  const fromEnv = process.env.HERMIT_KEY || process.env.ASST_KEY;
  if (fromEnv) return fromEnv;
  // Never printed, never passed on a command line — same rule as everywhere else.
  return execSync('security find-generic-password -a asst -s asst-gateway-vps-key -w', {
    encoding: 'utf8',
  }).trim();
}
const KEY = machineKey();
const H = { 'x-asst-key': KEY, 'content-type': 'application/json' };

async function query(proc, input = null) {
  const url = `${DASH}/api/trpc/${proc}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: input } }))}`;
  const r = await fetch(url, { headers: H });
  const j = await r.json();
  if (j?.[0]?.error) throw new Error(j[0].error.json.message);
  return j?.[0]?.result?.data?.json;
}
async function mutate(proc, input) {
  const r = await fetch(`${DASH}/api/trpc/${proc}?batch=1`, {
    method: 'POST', headers: H, body: JSON.stringify({ 0: { json: input } }),
  });
  const j = await r.json();
  if (j?.[0]?.error) throw new Error(j[0].error.json.message);
  return j?.[0]?.result?.data?.json;
}

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const target = (() => {
  const i = argv.indexOf('--to');
  return i >= 0 ? argv[i + 1] : 'claude-sdk';
})();
const only = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? new Set(argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean)) : null;
})();
const from = target === 'claude-sdk' ? 'claude-tmux' : 'claude-sdk';

const agents = await query('agents.list', null);
if (only) {
  const missing = [...only].filter((n) => !agents.some((a) => a.name === n));
  if (missing.length) {
    console.error(`unknown agent(s): ${missing.join(', ')}`);
    process.exit(1);
  }
}

// Only agents whose default is ACTUALLY the backend we are migrating away from.
//
// This is the whole safety property of the script and it is not optional: an
// agent deliberately defaulted to codex or pi is on a different vendor, and
// rewriting it to a claude backend is not "moving the tmux driver to the SDK
// driver", it is changing what the agent IS. `agents.list` does not carry the
// column, so each candidate is read individually — a handful of small requests,
// once, against a decision that is expensive to get wrong.
//
// An agent with NO stored default already follows the fleet default and needs
// no write; touching it would turn "inherits" into a pin.
const named = agents.filter((a) => !only || only.has(a.name));
const picked = [];
const untouched = [];
for (const a of named) {
  // No catch. A read that fails must STOP the run, not be folded into "this
  // agent has no default" — that is a guess, and a guess is the one thing a
  // script that rewrites fleet configuration must never make. (It read
  // `detail.runtime` here at first; the payload is `{agent: {...}}`, so every
  // agent silently looked default-less and the whole migration would have
  // reported nothing to do.)
  const detail = await query('agents.byName', { name: a.name });
  const row = detail?.agent;
  if (!row) {
    console.error(`could not read the current default for ${a.name} — refusing to guess. Nothing was changed.`);
    process.exit(1);
  }
  const stored = row.runtime ?? null;
  if (stored === from) picked.push(a);
  else untouched.push({ name: a.name, runtime: stored ?? '(inherits the fleet default)' });
}

// Which live sessions actually move. A session that pinned its own backend is
// untouched by an agent default, so counting agents alone would overstate this.
const sessions = [];
for (const a of picked) {
  const rows = await query('chat.listSessions', { agentName: a.name }).catch(() => []);
  for (const s of Array.isArray(rows) ? rows : rows?.sessions ?? []) {
    if (s.closedAt) continue;
    const d = await query('chat.sessionDetail', { sessionId: s.id }).catch(() => null);
    if (!d || d.backend?.runtime !== from) continue;
    sessions.push({ id: s.id, agent: a.name, pinned: !!d.runtime, working: d.state === 'working' });
  }
}
const willFlip = sessions.filter((s) => !s.pinned);
const staysPinned = sessions.filter((s) => s.pinned);
const midTurn = willFlip.filter((s) => s.working);

console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${from} → ${target}`);
console.log(`  agents to update:                 ${picked.length} (of ${named.length} looked at)`);
if (untouched.length) {
  console.log(`  agents left alone:                ${untouched.length}`);
  for (const u of untouched) console.log(`      ${u.name} — ${u.runtime}`);
}
console.log(`  live sessions that would move:    ${willFlip.length}`);
console.log(`  live sessions pinned (unchanged): ${staysPinned.length}`);
console.log(`  of the movers, mid-turn right now: ${midTurn.length} (they move on their next message)`);
if (!apply) {
  console.log('\nnothing was changed. re-run with --apply to do it.');
  process.exit(0);
}

let ok = 0, failed = 0;
for (const a of picked) {
  try {
    await mutate('agents.setDefaultRuntime', { name: a.name, runtime: target });
    ok++;
  } catch (e) {
    failed++;
    console.error(`  ${a.name}: ${e.message.slice(0, 100)}`);
  }
}
console.log(`\ndone — ${ok} agent(s) updated, ${failed} failed.`);
console.log(`roll back with: --apply --to ${from}${only ? ` --only ${[...only].join(',')}` : ''}`);
