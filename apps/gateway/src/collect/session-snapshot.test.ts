import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeRuntime } from './session-snapshot';
import type { AgentRuntime, RuntimeUsage } from '../runtime/types';

function fakeRuntime(live: RuntimeUsage | null, stored: RuntimeUsage | null): AgentRuntime {
  return {
    kind: 'codex-exec',
    async ensure() { throw new Error('not used'); },
    async submit() { return false; },
    async isWorking() { return false; },
    async interrupt() {},
    async compact() {},
    async usage() { return live; },
    async storedUsage() { return stored; },
    async stop() {},
  };
}

const stored: RuntimeUsage = {
  contextTokens: 26_630,
  outputTokens: 512,
  totalTokens: 12_173_126,
  costUsd: null,
};

test('durable usage repairs tokens without waking an offline session', async () => {
  const snapshot = await probeRuntime(
    fakeRuntime(null, stored),
    'session-id',
    'agent',
    '/tmp/no-loop-state-here',
    'codex-thread-id',
  );
  assert.equal(snapshot.contextTokens, 26_630);
  assert.equal(snapshot.outputTokens, 512);
  assert.equal(snapshot.alive, false);
  assert.equal(snapshot.state, null);
});

test('live usage still marks an idle runtime handle alive', async () => {
  const snapshot = await probeRuntime(
    fakeRuntime(stored, null),
    'session-id',
    'agent',
    '/tmp/no-loop-state-here',
    'codex-thread-id',
  );
  assert.equal(snapshot.contextTokens, 26_630);
  assert.equal(snapshot.alive, true);
  assert.equal(snapshot.state, 'idle');
});
