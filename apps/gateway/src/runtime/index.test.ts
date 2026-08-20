import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFor, allRuntimes } from './index';

// Which ENGINE runs is declared by the mode, not by the backend kind — and each
// engine keeps its own live-handle map. Pick the wrong one and every lookup for
// that session (isWorking, usage) misses, which is how omp sessions ended up
// showing a blank context bar while their child was healthy.

test('claude-tmux and anything unrecognised keep the tmux path', () => {
  assert.equal(runtimeFor('claude-tmux', null), null);
  assert.equal(runtimeFor(null, null), null);
  assert.equal(runtimeFor('something-else', 'omp'), null);
});

test('a pi-engine mode gets pi', () => {
  assert.equal(runtimeFor('pi-rpc', 'coding')?.kind, 'pi-rpc');
  assert.equal(runtimeFor('pi-rpc', 'ops')?.kind, 'pi-rpc');
});

test('an absent or unknown mode falls back to the default mode, which is omp', () => {
  assert.equal(runtimeFor('pi-rpc', null)?.kind, 'omp-rpc');
  assert.equal(runtimeFor('pi-rpc', undefined)?.kind, 'omp-rpc');
  assert.equal(runtimeFor('pi-rpc', 'no-such-mode')?.kind, 'omp-rpc');
});

test('the omp mode gets omp — the regression that blanked its context bar', () => {
  assert.equal(runtimeFor('pi-rpc', 'omp')?.kind, 'omp-rpc');
});

test('each runtime is a singleton, so the handle map survives across ticks', () => {
  // probeRuntime looks a session up by id in the runtime's own map. A fresh
  // instance per call would find nothing, every time.
  assert.equal(runtimeFor('pi-rpc', 'omp'), runtimeFor('pi-rpc', 'omp'));
  assert.equal(runtimeFor('pi-rpc', 'coding'), runtimeFor('pi-rpc', 'coding'));
});

test('codex is its own backend and takes no mode', () => {
  assert.equal(runtimeFor('codex-exec', null)?.kind, 'codex-exec');
  assert.equal(runtimeFor('codex-exec', 'omp')?.kind, 'codex-exec');
  assert.equal(runtimeFor('codex-exec', 'coding')?.kind, 'codex-exec');
  // Singleton for the same reason the others are: probeRuntime looks a session
  // up by id in the runtime's own map.
  assert.equal(runtimeFor('codex-exec', null), runtimeFor('codex-exec', null));
});

// Prime has exactly ONE built-in tool, so a mode's tool allowlist — written in
// pi's vocabulary of read/bash/edit/write — would name four tools that do not
// exist and drop the only one that does. It takes no mode for that reason, and
// resolveRuntime nulls one out upstream.
test('prime is its own harness and takes no mode', () => {
  assert.equal(runtimeFor('prime-rpc', null)?.kind, 'prime-rpc');
  assert.equal(runtimeFor('prime-rpc', 'omp')?.kind, 'prime-rpc');
  assert.equal(runtimeFor('prime-rpc', 'coding')?.kind, 'prime-rpc');
  // Singleton for the same reason the others are: probeRuntime looks a session
  // up by id in the runtime's own map.
  assert.equal(runtimeFor('prime-rpc', null), runtimeFor('prime-rpc', null));
});

test('dsh is its own backend and takes no mode', () => {
  assert.equal(runtimeFor('dsh-exec', null)?.kind, 'dsh-exec');
  assert.equal(runtimeFor('dsh-exec', 'omp')?.kind, 'dsh-exec');
  assert.equal(runtimeFor('dsh-exec', null), runtimeFor('dsh-exec', null));
});

test('teardown paths see every engine', () => {
  assert.deepEqual(
    allRuntimes().map((r) => r.kind).sort(),
    ['claude-sdk', 'codex-exec', 'dsh-exec', 'omp-rpc', 'pi-rpc', 'prime-rpc'],
  );
});

test('claude-sdk is its own backend and takes no mode', () => {
  assert.equal(runtimeFor('claude-sdk', null)?.kind, 'claude-sdk');
  assert.equal(runtimeFor('claude-sdk', 'omp')?.kind, 'claude-sdk');
  // Singleton, for the same reason the others are: the live-handle map that
  // owns a session's query object is module state, so two instances would each
  // see half the fleet.
  assert.equal(runtimeFor('claude-sdk', null), runtimeFor('claude-sdk', null));
});

// The pane path is reached by returning null, and it has to STAY reachable:
// it is the fallback for the one thing the SDK cannot do (outlive the gateway),
// and a session already running on it must not be silently re-pointed.
test('claude-tmux still means the inline pane path', () => {
  assert.equal(runtimeFor('claude-tmux', null), null);
  assert.equal(runtimeFor(null, null), null);
  assert.equal(runtimeFor('something-unknown', null), null);
});

// Both claude backends must be able to hand a session to each other, which
// only works if they agree on what an external session id IS.
test('claude-sdk accepts image attachments, the child-process backends do not', () => {
  assert.equal(runtimeFor('claude-sdk', null)?.acceptsImages, true);
  assert.ok(!runtimeFor('codex-exec', null)?.acceptsImages);
  assert.ok(!runtimeFor('pi-rpc', 'omp')?.acceptsImages);
});
