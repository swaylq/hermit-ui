import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeRuntime, needsStoredUsage } from './session-snapshot';
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

// ── needsStoredUsage ────────────────────────────────────────────────────────
// The gate that keeps an 8-second tick off the filesystem. It must be false in
// the common case (the transcript tail already carried the usage record) and
// true in every case where skipping it would blank a context bar that used to
// render — the snapshot has to stay byte-identical to the unconditional version.

const both = (c: number | null, o: number | null) => ({ contextTokens: c, outputTokens: o });

test('a live session never reads the disk fallback — its handle outranks it', () => {
  assert.equal(needsStoredUsage(true, both(null, null), null), false);
  assert.equal(needsStoredUsage(true, both(null, null), both(null, null)), false);
});

test('the common case: the tail already answered, so nothing is read', () => {
  assert.equal(needsStoredUsage(false, both(24_000, 700), null), false);
});

test('the runtime answering is enough too, even with an empty tail', () => {
  assert.equal(needsStoredUsage(false, both(null, null), both(24_000, 700)), false);
});

test('nothing in hand: the fallback fires, which is what it is for', () => {
  assert.equal(needsStoredUsage(false, both(null, null), null), true);
  assert.equal(needsStoredUsage(false, both(null, null), both(null, null)), true);
});

// They come off one transcript event, so they move together — but the gate asks
// about each rather than assuming, so a half-answer still reaches the fallback
// instead of silently dropping the missing half.
test('half an answer still reads the fallback', () => {
  assert.equal(needsStoredUsage(false, both(24_000, null), null), true);
  assert.equal(needsStoredUsage(false, both(null, 700), null), true);
  assert.equal(needsStoredUsage(false, both(24_000, null), both(null, 700)), false);
});

// Zero is a measurement, not a missing value: a session whose window really is
// empty must not send the collector back to the disk on every tick.
test('zero is an answer, not an absence', () => {
  assert.equal(needsStoredUsage(false, both(0, 0), null), false);
});
