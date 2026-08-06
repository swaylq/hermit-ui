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

test('teardown paths see every engine', () => {
  assert.deepEqual(allRuntimes().map((r) => r.kind).sort(), ['omp-rpc', 'pi-rpc']);
});
