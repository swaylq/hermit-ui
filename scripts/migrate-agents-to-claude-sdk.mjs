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
const picked = agents.filter((a) => !only || only.has(a.name));
if (only) {
  const missing = [...only].filter((n) => !agents.some((a) => a.name === n));
  if (missing.length) {
    console.error(`unknown agent(s): ${missing.join(', ')}`);
    process.exit(1);
  }
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
console.log(`  agents to update:                 ${picked.length}${only ? ` (of ${agents.length})` : ''}`);
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
