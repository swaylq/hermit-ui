// E2E: the REAL DshExecRuntime against a REAL dsh install, no mocks.
//
//   cd apps/gateway && npx tsx scripts/dsh-e2e.mts
//
// Needs dsh installed (~/.dsh/profiles/node_modules or HERMIT_DSH_BIN). With
// DEEPSEEK_API_KEY in the secret store it exercises full turns; WITHOUT one it
// still proves the whole pipeline — spawn, hermit.patch.yml mounting the
// runner, session creation, the fd-3 protocol, the MISSING_CREDENTIAL turn
// surfacing in the chat instead of vanishing, and resume on turn 2 — which is
// exactly the state a fresh machine is in. Not part of `npm test`: it boots a
// real dsh tree per turn (~3s each) and, with a key, costs real tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshExecRuntime, resolveDshCommand } from '../src/runtime/dsh-exec.ts';
import type { SyncItem } from '../src/runtime/types.ts';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ✔ ${label}`); }
  else { fail += 1; console.log(`  ✘ ${label} ${detail}`); }
}

if (!resolveDshCommand()) {
  console.error('dsh is not installed on this machine — nothing to test against.');
  process.exit(2);
}

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-dsh-e2e-'));
fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), '# test agent\n');

const rt = new DshExecRuntime();
const emitted: SyncItem[] = [];
const emit = (i: SyncItem) => { emitted.push(i); };

const session = {
  id: 'sess-dsh-e2e-01',
  agentName: 'e2e',
  agentDirectory: agentDir,
  externalSessionId: null as string | null,
  provider: null,
  model: null,
  mode: null,
};

async function settle(h: Awaited<ReturnType<typeof rt.ensure>>, label: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await rt.isWorking(h))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  check(`${label} finished within ${timeoutMs}ms`, false);
  return false;
}

const texts = () => emitted.map((i) => JSON.stringify(i.content)).join('\n');

console.log('\n── turn 1: fresh dsh session ──');
let handle = await rt.ensure(session, emit);
check('a fresh session starts with no dsh session id', handle.externalSessionId === '');
check('usage before any turn is null', (await rt.usage(handle)) === null);

const ok1 = await rt.submit(handle, 'Reply with exactly the word pong and nothing else. Do not use any tool.', []);
check('submit returns true', ok1);
check('isWorking is true while the turn runs', await rt.isWorking(handle));
await settle(handle, 'turn 1');

const stamp = emitted.find((i) => i.claudeSessionId);
check('the dsh session id was stamped for resume', !!stamp?.claudeSessionId, texts().slice(0, 400));
const dshId = stamp?.claudeSessionId ?? null;
check('the stamped id is a dsh session id', !!dshId && /^session-/.test(dshId));

const keyed = !texts().includes('MISSING_CREDENTIAL');
if (keyed) {
  check('the model answered', /pong/i.test(texts()));
  const u = await rt.usage(handle);
  check('usage is populated after a turn', !!u && u.totalTokens > 0, JSON.stringify(u));
} else {
  console.log('  (no DEEPSEEK_API_KEY — asserting the failure surfaces instead)');
  check('the missing key reaches the chat as a turn-ending row', texts().includes('MISSING_CREDENTIAL'));
  check('…as a system row, not silence', emitted.some((i) => i.role === 'system' && JSON.stringify(i.content).includes('MISSING_CREDENTIAL')));
}

console.log('\n── turn 2: resume the same dsh session ──');
await rt.stop(handle, 'hibernate');
const before = emitted.length;
handle = await rt.ensure({ ...session, externalSessionId: dshId }, emit);
check('ensure picks the recorded id back up', handle.externalSessionId === (dshId ?? ''));
const ok2 = await rt.submit(handle, 'Reply with exactly the word pang and nothing else. Do not use any tool.', []);
check('submit on the resumed session returns true', ok2);
await settle(handle, 'turn 2');
const turn2 = emitted.slice(before);
check('turn 2 produced rows', turn2.length > 0);
check(
  'the resumed turn kept the SAME dsh session (no re-stamp row)',
  !turn2.some((i) => i.claudeSessionId && i.claudeSessionId !== dshId),
  turn2.map((i) => i.claudeSessionId).filter(Boolean).join(','),
);
if (keyed) check('the model answered on resume', /pang/i.test(texts().slice(before)));

console.log('\n── a foreign external id self-heals ──');
await rt.stop(handle, 'hibernate');
const beforeForeign = emitted.length;
handle = await rt.ensure({ ...session, id: 'sess-dsh-e2e-02', externalSessionId: 'b1946ac9-2f5a-4bfa-a0ed-9d3b0c4d1111' }, emit);
check('a claude-shaped uuid is not taken as a dsh session', handle.externalSessionId === '');
const ok3 = await rt.submit(handle, 'Reply with exactly the word ping and nothing else. Do not use any tool.', []);
check('the turn still runs (fresh session)', ok3);
await settle(handle, 'foreign-id turn');
check('a fresh session id was stamped', emitted.slice(beforeForeign).some((i) => i.claudeSessionId?.startsWith('session-')));

console.log('\n── interrupt ──');
await rt.stop(handle, 'kill');
handle = await rt.ensure({ ...session, id: 'sess-dsh-e2e-03', externalSessionId: null }, emit);
const beforeInt = emitted.length;
await rt.submit(handle, 'Reply with a 300 word essay about pipes.', []);
await new Promise((r) => setTimeout(r, 700));
// Without a key the turn dies (MISSING_CREDENTIAL) in under a second, so the
// interrupt can arrive after the child is already gone — that is a no-op by
// design, not a failure, and the row assertion only holds when it landed.
const stillRunning = await rt.isWorking(handle);
await rt.interrupt(handle);
await settle(handle, 'interrupted turn', 30_000);
check('interrupt clears isWorking', !(await rt.isWorking(handle)));
if (stillRunning) {
  check('the interruption is visible in the chat', emitted.slice(beforeInt).some((i) => JSON.stringify(i.content).includes('interrupted')));
} else {
  console.log('  (turn had already ended when the interrupt fired — row assertion skipped)');
}

// ── the pi endpoint bridge (claude models over the machine's relay) ─────────
// Runs only where the pi endpoint is configured (HERMIT_PI_* env, or a live
// dashboard behind getPiConfig) AND its secret exists — i.e. a real fleet
// machine. Costs one real claude-haiku turn.
await rt.stop(handle, 'kill');
const piProvider = process.env.HERMIT_PI_PROVIDER?.trim();
const piModels = (process.env.HERMIT_PI_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean);
if (piProvider && piModels.length > 0) {
  console.log(`\n── bridge: a ${piProvider} model through dsh ──`);
  const model = piModels.find((m) => m.includes('haiku')) ?? piModels[0];
  handle = await rt.ensure({ ...session, id: 'sess-dsh-e2e-04', externalSessionId: null, model }, emit);
  const beforeBridge = emitted.length;
  const okB = await rt.submit(handle, 'Reply with exactly the word bridged and nothing else. Do not use any tool.', []);
  check('submit with a relay model pin returns true', okB);
  await settle(handle, 'bridge turn');
  const bridgeText = emitted.slice(beforeBridge).map((i) => JSON.stringify(i.content)).join('\n');
  check(`the ${model} turn answered through ${piProvider}`, /bridged/i.test(bridgeText), bridgeText.slice(0, 400));
  const uB = await rt.usage(handle);
  check('usage is populated for the bridged turn', !!uB && uB.totalTokens > 0, JSON.stringify(uB));
  await rt.stop(handle, 'kill');
} else {
  console.log('\n(no pi endpoint configured in this environment — bridge leg skipped)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
