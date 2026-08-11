// E2E: the REAL CodexExecRuntime against a REAL codex, no mocks.
//
//   cd apps/gateway && npx tsx scripts/codex-e2e.mts
//
// Needs `codex login` on this machine. Costs a handful of real turns, which is
// why it is not part of `npm test`.
//
// Mirrors what the linux-compat design doc did for the tmux driver: import the
// actual runtime and walk the lifecycle chat-runner walks, asserting on what
// the dashboard would receive.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexExecRuntime } from '../src/runtime/codex-exec.ts';
import type { SyncItem } from '../src/runtime/types.ts';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ✔ ${label}`); }
  else { fail += 1; console.log(`  ✘ ${label} ${detail}`); }
}

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-codex-e2e-'));
fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), '# test agent\n');

const rt = new CodexExecRuntime();
const emitted: SyncItem[] = [];
const emit = (i: SyncItem) => { emitted.push(i); };

const session = {
  id: 'sess-e2e-0001',
  agentName: 'e2e',
  agentDirectory: agentDir,
  externalSessionId: null as string | null,
  provider: null,
  model: null,
  mode: null,
};

async function settle(h: any, label: string, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  // isWorking is set synchronously by submit(), so poll until it clears.
  while (Date.now() < deadline) {
    if (!(await rt.isWorking(h))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  check(`${label} finished within ${timeoutMs}ms`, false);
  return false;
}

console.log('\n── turn 1: fresh thread, a shell command ──');
let handle = await rt.ensure(session, emit);
check('a fresh session starts with no thread id', handle.externalSessionId === '');
check('usage before any turn is null', (await rt.usage(handle)) === null);

const ok1 = await rt.submit(handle, 'Run the shell command `echo hermit-e2e-marker` and then say, in one short sentence, what it printed.', []);
check('submit returns true', ok1);
check('isWorking is true while the turn runs', await rt.isWorking(handle));
await settle(handle, 'turn 1');

const roles = emitted.map((e) => `${e.role}:${(e.content as any)[0]?.type}`);
console.log('  rows:', roles.join(', '));
check('an assistant text row arrived', emitted.some((e) => e.role === 'assistant' && (e.content as any)[0]?.type === 'text'));
const toolUse = emitted.find((e) => (e.content as any)[0]?.type === 'tool_use');
const toolRes = emitted.find((e) => (e.content as any)[0]?.type === 'tool_result');
check('the shell call rendered as a tool_use', !!toolUse, JSON.stringify(toolUse?.content));
check('the tool_use is named Bash', (toolUse?.content as any)?.[0]?.name === 'Bash');
check('its output rendered as a tool_result', !!toolRes);
check('the tool_result carries the marker', String((toolRes?.content as any)?.[0]?.content ?? '').includes('hermit-e2e-marker'));
check('tool_use id and tool_result tool_use_id match',
  (toolUse?.content as any)?.[0]?.id === (toolRes?.content as any)?.[0]?.tool_use_id);

const stamp = emitted.find((e) => e.claudeSessionId);
check('the thread id was stamped for the DB', !!stamp?.claudeSessionId);
const threadId = stamp?.claudeSessionId ?? '';
console.log('  thread id:', threadId);

const u1 = await rt.usage(handle);
console.log('  usage turn 1:', JSON.stringify(u1));
check('turn 1 reports a context figure', typeof u1?.contextTokens === 'number' && u1!.contextTokens! > 0);
check('cost is null (subscription, no per-token price)', u1?.costUsd === null);

console.log('\n── turn 2: same handle, context must carry ──');
const before = emitted.length;
await rt.submit(handle, 'What exact string did that command print? Answer with just the string.', []);
await settle(handle, 'turn 2');
const turn2 = emitted.slice(before);
const answer = turn2.filter((e) => e.role === 'assistant').map((e) => (e.content as any)[0]?.text ?? '').join(' ');
check('turn 2 remembered the marker', answer.includes('hermit-e2e-marker'), `got: ${answer.slice(0, 80)}`);

const u2 = await rt.usage(handle);
console.log('  usage turn 2:', JSON.stringify(u2));
check('turn 2 context is a PER-TURN figure, not the cumulative total',
  u2!.contextTokens! < u2!.totalTokens!, `ctx=${u2?.contextTokens} total=${u2?.totalTokens}`);
check('cumulative total grew across turns', u2!.totalTokens > u1!.totalTokens);

// The id trap: codex ids restart at item_0 every turn, so two DIFFERENT logical
// rows must never share an externalId (the sync route upserts on it). A repeat
// is legitimate only when it is the same row emitted again — the started →
// completed upsert of a tool call, which is what makes a running command
// visible before it finishes.
const byId = new Map<string, { role: string; type: string; id: unknown }>();
let collisions = 0;
for (const e of emitted) {
  const block = (e.content as any)[0] ?? {};
  const sig = { role: e.role, type: block.type, id: block.id };
  const prev = byId.get(e.externalId);
  if (prev && JSON.stringify(prev) !== JSON.stringify(sig)) {
    collisions += 1;
    console.log(`    collision on ${e.externalId}: ${JSON.stringify(prev)} vs ${JSON.stringify(sig)}`);
  }
  byId.set(e.externalId, sig);
}
check('no two distinct rows share an externalId', collisions === 0, `${collisions} collisions`);
const upserts = emitted.length - byId.size;
check('the repeats are exactly the tool-call upserts', upserts > 0 && collisions === 0,
  `${emitted.length} rows, ${byId.size} ids, ${upserts} upserts`);

console.log('\n── restart: stop(), then resume from the stamped thread id ──');
await rt.stop(handle, 'hibernate');
check('usage after stop is null (handle gone, like a gateway restart)', (await rt.usage(handle)) === null);

const resumedSession = { ...session, externalSessionId: threadId };
handle = await rt.ensure(resumedSession, emit);
check('the resumed handle reports the thread id', handle.externalSessionId === threadId);
const seeded = await rt.usage(handle);
console.log('  usage seeded from the rollout file:', JSON.stringify(seeded));
check('the baseline was seeded from codex\'s own rollout, not left blank', seeded !== null);
check('the seeded context is per-turn sized, not the whole history',
  !!seeded && seeded.contextTokens! < seeded.totalTokens!, JSON.stringify(seeded));

const before3 = emitted.length;
await rt.submit(handle, 'One more time: just that exact string, nothing else.', []);
await settle(handle, 'turn 3');
const turn3 = emitted.slice(before3).filter((e) => e.role === 'assistant').map((e) => (e.content as any)[0]?.text ?? '').join(' ');
check('the resumed thread still had the conversation', turn3.includes('hermit-e2e-marker'), `got: ${turn3.slice(0, 80)}`);

console.log('\n── interrupt ──');
const before4 = emitted.length;
await rt.submit(handle, 'Count slowly from 1 to 40, one number per line, pausing between each.', []);
await new Promise((r) => setTimeout(r, 2500));
await rt.interrupt(handle);
await settle(handle, 'interrupted turn', 60_000);
check('isWorking cleared after the interrupt', !(await rt.isWorking(handle)));
const note = emitted.slice(before4).find((e) => String((e.content as any)[0]?.text ?? '').includes('interrupted'));
check('the interruption is visible in the chat', !!note,
  JSON.stringify(emitted.slice(before4).map((e) => (e.content as any)[0]?.text?.slice(0, 40))));

await rt.stop(handle, 'kill');
fs.rmSync(agentDir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
