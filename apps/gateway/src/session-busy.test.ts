import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionIsBusy, type BusySession } from './session-busy';
import { runtimeFor, type AgentRuntime } from './runtime';

// The regression these pin: `tmux capture-pane` against a session that has no
// pane exits 1 with empty stdout, which the pane reader reports as "captured it,
// no work marker" — i.e. IDLE — instead of "could not read". Every claude-sdk
// session therefore answered idle forever, and the one caller that gates on the
// answer (machine-level restart-all) skipped nothing and killed live turns.

const fakeRuntime = (working: boolean, seen?: { handle?: unknown }): AgentRuntime =>
  ({
    kind: 'claude-sdk',
    isWorking: async (handle: unknown) => {
      if (seen) seen.handle = handle;
      return working;
    },
  }) as unknown as AgentRuntime;

const paneSpy = () => {
  const calls: unknown[][] = [];
  const pane = async (...args: unknown[]) => {
    calls.push(args);
    return false;
  };
  return { calls, pane: pane as never };
};

const sdkSession: BusySession = {
  id: 'sess-1',
  runtime: 'claude-sdk',
  claudeSessionId: 'cc-uuid-1',
  agentDirectory: '/Users/mac/claudeclaw/asst',
};

test('a backend-owned session gets its verdict from the backend, not the pane', async () => {
  const spy = paneSpy();
  assert.equal(
    await sessionIsBusy(sdkSession, { lookup: () => fakeRuntime(true), pane: spy.pane }),
    true,
  );
  assert.deepEqual(spy.calls, [], 'the pane must never be consulted for a paneless session');
});

test('a backend that says idle is believed — the skip gate still lets it restart', async () => {
  const spy = paneSpy();
  assert.equal(
    await sessionIsBusy(sdkSession, { lookup: () => fakeRuntime(false), pane: spy.pane }),
    false,
  );
  assert.deepEqual(spy.calls, []);
});

// handleOf() keys the live map on sessionId; a handle built with the wrong id
// finds nothing and reports idle, which is the same silent failure by another
// route.
test('the handle carries the session id the live map is keyed on', async () => {
  const seen: { handle?: unknown } = {};
  await sessionIsBusy(sdkSession, { lookup: () => fakeRuntime(true, seen) });
  assert.deepEqual(seen.handle, { sessionId: 'sess-1', externalSessionId: 'cc-uuid-1' });
});

test('a session with no claude session id yet still probes cleanly', async () => {
  const seen: { handle?: unknown } = {};
  await sessionIsBusy({ id: 'sess-2', runtime: 'claude-sdk' }, { lookup: () => fakeRuntime(false, seen) });
  assert.deepEqual(seen.handle, { sessionId: 'sess-2', externalSessionId: '' });
});

// The other half: what runtimeFor declines is still the pane's, and it must be
// handed the context that makes the pane verdict right. Passing only the id —
// how this call site used to read — leaves transcript freshness and the
// narrow-pane hook fallback inert, so a tmux session in a long quiet think, or
// on a pane too narrow to render the mode line, answered idle there too.
test('a pane-backed session falls through to the pane WITH its transcript context', async () => {
  const spy = paneSpy();
  const s: BusySession = {
    id: 'sess-3',
    runtime: 'claude-tmux',
    claudeSessionId: 'cc-uuid-3',
    agentDirectory: '/Users/mac/claudeclaw/asst',
  };
  assert.equal(await sessionIsBusy(s, { pane: spy.pane }), false);
  assert.equal(spy.calls.length, 1);
  const [id, transcriptPath, agentDir, claudeSessionId] = spy.calls[0];
  assert.equal(id, 'sess-3');
  assert.equal(agentDir, '/Users/mac/claudeclaw/asst');
  assert.equal(claudeSessionId, 'cc-uuid-3');
  assert.match(String(transcriptPath), /cc-uuid-3\.jsonl$/);
});

test('an unrecognised backend lands on the pane, the same fallback runtimeFor makes', async () => {
  const spy = paneSpy();
  await sessionIsBusy({ id: 'sess-4', runtime: 'something-from-the-future' }, { pane: spy.pane });
  await sessionIsBusy({ id: 'sess-5' }, { pane: spy.pane });
  assert.equal(spy.calls.length, 2);
});

// Adding a backend must not be able to reintroduce the bug: there is no
// `kind === ...` list here to forget to extend.
test('every child-process backend is asked itself, using the real lookup', async () => {
  for (const runtime of ['claude-sdk', 'codex-exec', 'dsh-exec', 'prime-rpc']) {
    const spy = paneSpy();
    assert.equal(await sessionIsBusy({ id: 'sess-x', runtime }, { pane: spy.pane }), false, runtime);
    assert.deepEqual(spy.calls, [], `${runtime} must not touch the pane`);
  }
  // pi's mode picks the engine, and each engine owns a different handle map.
  const spy = paneSpy();
  await sessionIsBusy({ id: 'sess-y', runtime: 'pi-rpc', runtimeMode: 'omp' }, { pane: spy.pane });
  assert.deepEqual(spy.calls, []);
  assert.equal(runtimeFor('pi-rpc', 'omp')?.kind, 'omp-rpc');
});

test('a probe that throws reads idle rather than propagating out of the op', async () => {
  const thrower = { kind: 'claude-sdk', isWorking: async () => { throw new Error('boom'); } } as unknown as AgentRuntime;
  assert.equal(await sessionIsBusy(sdkSession, { lookup: () => thrower }), false);
  const paneThrows = (async () => { throw new Error('tmux gone'); }) as never;
  assert.equal(await sessionIsBusy({ id: 'sess-6', runtime: 'claude-tmux' }, { pane: paneThrows }), false);
});
