// Integration tests for the kimi-code runtime — a REAL Kimi Code CLI, a real
// endpoint, no mocks.
//
// Separate from the default suite because these spend real subscription quota
// and real minutes. `npm test` must stay offline and fast; run these with
// `npm run test:integration`, and run them before shipping a change to this
// runtime, because every property they check is one the unit tests cannot see:
// whether the env-only credential really does authenticate, whether the CLI
// really resumes, and whether the token counters really appear in the log.
//
// Needs, on this machine:
//   · `kimi` installed (or HERMIT_KIMI_BIN pointing at it),
//   · a credential in Settings → Models this gateway can fetch — so DASHBOARD_URL
//     and ASST_KEY have to be in the environment, exactly as the gateway has
//     them,
//   · the secret that credential names, in the machine's encrypted store.
//
// Any of those missing SKIPS rather than fails: a laptop with no Kimi
// subscription should not have a red suite.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KimiCodeRuntime, kimiHome, resolveKimiCommand, wireFileFor } from './kimi-code';
import { getCredential } from '../pi-config';
import { readSecret } from './pi-credentials';
import type { RuntimeHandle, SyncItem } from './types';

/** Which credential to run against. Any Kimi-shaped one will do. */
const CREDENTIAL_ID = process.env.HERMIT_KIMI_IT_CREDENTIAL?.trim() || 'kimi-code';

const CODEWORD = 'ORCHID-9';
let AGENT_DIR = '';
let HOME_DIR = '';
let skipReason: string | null = null;
let seq = 0;

before(async () => {
  if (!resolveKimiCommand()) {
    skipReason = 'the kimi CLI is not on this machine';
    return;
  }
  const credential = await getCredential(CREDENTIAL_ID);
  if (!credential || credential.id !== CREDENTIAL_ID) {
    skipReason = `no "${CREDENTIAL_ID}" credential on this machine (is ASST_KEY set?)`;
    return;
  }
  if (!credential.secretKey || !(await readSecret(credential.secretKey))) {
    skipReason = `the secret ${credential.secretKey ?? '(unnamed)'} is not in this machine's store`;
    return;
  }

  AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-kimi-it-'));
  fs.writeFileSync(
    path.join(AGENT_DIR, 'AGENTS.md'),
    `# probe-agent\n\nWhen asked for the codeword, answer with exactly: ${CODEWORD}\n`,
  );
  // Its own store, so these runs never appear in the human's `kimi -S` picker
  // and the assertions read a log nothing else is appending to.
  HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-kimi-it-home-'));
  process.env.HERMIT_KIMI_HOME = HOME_DIR;
});

after(() => {
  delete process.env.HERMIT_KIMI_HOME;
  for (const dir of [AGENT_DIR, HOME_DIR]) {
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

type Session = {
  rt: KimiCodeRuntime;
  handle: RuntimeHandle;
  items: SyncItem[];
  /** Submit and wait for the turn to finish. Returns its assistant text. */
  turn: (text: string, ms?: number) => Promise<string>;
};

async function open(externalSessionId: string | null = null): Promise<Session> {
  const rt = new KimiCodeRuntime();
  const items: SyncItem[] = [];
  const handle = await rt.ensure(
    {
      id: `it-${Date.now()}-${seq++}`,
      agentName: 'probe-agent',
      agentDirectory: AGENT_DIR,
      externalSessionId,
      credentialId: CREDENTIAL_ID,
    },
    (i) => items.push(i),
  );

  const turn = async (text: string, ms = 300_000) => {
    const before_ = items.length;
    assert.equal(await rt.submit(handle, text, []), true, 'submit was refused');
    const t0 = Date.now();
    while (Date.now() - t0 < 5_000 && !(await rt.isWorking(handle))) {
      await new Promise((r) => setTimeout(r, 50));
    }
    while (Date.now() - t0 < ms && (await rt.isWorking(handle))) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 300));
    return assistantText(items.slice(before_));
  };

  return { rt, handle, items, turn };
}

function assistantText(items: SyncItem[]): string {
  return items
    .filter((i) => i.role === 'assistant')
    .flatMap((i) => (Array.isArray(i.content) ? i.content : []))
    .filter((b: unknown) => (b as { type?: string })?.type === 'text')
    .map((b: unknown) => String((b as { text?: string }).text ?? ''))
    .join('\n');
}

function blocks(items: SyncItem[], type: string): Record<string, unknown>[] {
  return items
    .flatMap((i) => (Array.isArray(i.content) ? i.content : []))
    .filter((b: unknown) => (b as { type?: string })?.type === type) as Record<string, unknown>[];
}

/** node:test has no dynamic skip from `before`, so each test asks. */
function guard(t: { skip: (why: string) => void }): boolean {
  if (skipReason) { t.skip(skipReason); return true; }
  return false;
}

// The whole backend in one turn: the env-only credential authenticates (no
// config.toml anywhere), the answer streams back as content blocks, and the
// session id is stamped for the next turn.
test('a turn answers, and stamps the session id back', async (t) => {
  if (guard(t)) return;
  const s = await open();

  const text = await s.turn('Reply with exactly: PONG');
  assert.match(text, /PONG/);

  const stamped = s.items.map((i) => i.claudeSessionId).filter(Boolean);
  assert.equal(stamped.length >= 1, true, 'no session id was stamped');
  assert.match(String(stamped[0]), /^session_[0-9a-f]{8}-/);

  await s.rt.stop(s.handle, 'kill');
});

// The claim that makes this backend safe to ship: the key travels in the
// child's environment and nothing is written to kimi's config.
test('no config.toml is ever written', async (t) => {
  if (guard(t)) return;
  assert.equal(fs.existsSync(path.join(kimiHome(), 'config.toml')), false);
});

// An agent is its directory. If AGENTS.md did not reach the model, every hermit
// agent would run on this backend as a stranger — same tools, no identity, no
// instructions. kimi reads it from cwd, which is the only reason spawning with
// `cwd` set (there is no --cwd flag) is enough.
test('the agent own AGENTS.md reaches the model', async (t) => {
  if (guard(t)) return;
  const s = await open();

  const text = await s.turn('What is the codeword? Reply with only the codeword.');
  assert.match(text, new RegExp(CODEWORD));

  await s.rt.stop(s.handle, 'kill');
});

// A chat is not one turn. Resume is the difference between a conversation and a
// series of unrelated questions — and it is the half a unit test cannot fake.
test('the next turn resumes the same conversation', async (t) => {
  if (guard(t)) return;
  const s = await open();

  await s.turn('Remember this number and reply with just it: 4173');
  const second = await s.turn('What number did I just ask you to remember? Reply with only the digits.');
  assert.match(second, /4173/);

  await s.rt.stop(s.handle, 'kill');
});

// A tool call has to arrive as a tool_use/tool_result PAIR that reference each
// other, or the renderer draws an orphan.
test('a tool call and its result arrive paired', async (t) => {
  if (guard(t)) return;
  const s = await open();

  await s.turn('Run the shell command `echo HELLO-FROM-TOOL` and then tell me what it printed.');

  const calls = blocks(s.items, 'tool_use');
  const results = blocks(s.items, 'tool_result');
  assert.equal(calls.length >= 1, true, 'no tool_use block was emitted');
  assert.equal(results.length >= 1, true, 'no tool_result block was emitted');
  assert.equal(
    results.some((r) => calls.some((c) => c.id === r.tool_use_id)),
    true,
    'no tool_result pointed at a tool_use that was emitted',
  );

  await s.rt.stop(s.handle, 'kill');
});

// The stream-json protocol carries NO usage; these numbers come out of kimi's
// own session log, which is the part most likely to move under us.
test('token counters are read back out of the session log', async (t) => {
  if (guard(t)) return;
  const s = await open();
  await s.turn('Reply with exactly: OK');

  const usage = await s.rt.usage(s.handle);
  assert.ok(usage, 'no usage after a completed turn');
  assert.equal(typeof usage.contextTokens, 'number');
  assert.equal((usage.contextTokens ?? 0) > 0, true, 'context occupancy was not measured');
  assert.equal(usage.totalTokens > 0, true, 'session total was not accumulated');
  // Kimi Code bills against a subscription window, not per token.
  assert.equal(usage.costUsd, null);

  // And the same numbers must be recoverable with no live handle — which is
  // what a gateway restart leaves behind.
  const id = String(s.items.map((i) => i.claudeSessionId).filter(Boolean)[0]);
  assert.ok(wireFileFor(kimiHome(), id), 'the session log was not found through the index');
  const stored = await s.rt.storedUsage({ sessionId: s.handle.sessionId, externalSessionId: id });
  assert.ok(stored);
  assert.equal(stored.totalTokens > 0, true);

  await s.rt.stop(s.handle, 'kill');
});

// The CLI reads nothing from stdin, so argv is the only channel — and a pasted
// document is an ordinary chat message here. The fallback parks it in a temp
// file, which only works because --add-dir widens the workspace to reach it.
test('a prompt too large for argv still arrives', async (t) => {
  if (guard(t)) return;
  const s = await open();

  const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(2600); // ~114 KB
  const text = `${filler}\n\nIgnore everything above. Reply with exactly: BIGPROMPT-OK`;
  assert.equal(Buffer.byteLength(text, 'utf8') > 96 * 1024, true, 'the fixture must exceed the argv limit');

  const reply = await s.turn(text);
  assert.match(reply, /BIGPROMPT-OK/);

  await s.rt.stop(s.handle, 'kill');
});

// A failing turn must reach the reader. The CLI's real failure shape is the
// trap: it writes its version line to stdout FIRST and only then dies on
// stderr, so anything that judges "did we see output" reports nothing and the
// user gets an empty reply. Driven through a stand-in binary that reproduces
// exactly that shape — no quota spent, and the classification is what is under
// test.
test('a turn that dies after its first line still reports', async (t) => {
  if (guard(t)) return;

  const fake = path.join(HOME_DIR, 'fake-kimi.sh');
  fs.writeFileSync(
    fake,
    '#!/bin/sh\n'
    + 'printf \'{"role":"meta","type":"system.version","version":"0.38.0"}\\n\'\n'
    + 'echo "error: failed to run prompt: provider kimi-code has no credential configured" >&2\n'
    + 'exit 1\n',
    { mode: 0o700 },
  );
  process.env.HERMIT_KIMI_BIN = fake;
  try {
    const s = await open();
    await s.turn('anything');
    const notes = s.items.filter((i) => i.role === 'system');
    const text = JSON.stringify(notes);
    assert.match(text, /could not run this turn/);
    assert.match(text, /no credential configured/);
    await s.rt.stop(s.handle, 'kill');
  } finally {
    delete process.env.HERMIT_KIMI_BIN;
  }
});

// A foreign id in the shared claudeSessionId column must start a fresh session,
// not fail identically on every retry.
test('a session id from another backend is discarded, not resumed', async (t) => {
  if (guard(t)) return;
  // A claude transcript uuid — what the column holds after a backend switch
  // that dodged the reset path.
  const s = await open('3f2b0f16-1c1e-4b5a-9d3e-7a1c0b2d4e6f');
  assert.equal(s.handle.externalSessionId, '');

  const text = await s.turn('Reply with exactly: FRESH');
  assert.match(text, /FRESH/);

  await s.rt.stop(s.handle, 'kill');
});
