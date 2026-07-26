import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSync, type ProbeRow } from './sync-plan';
import type { CachedSession } from './types';

function probe(sessionId: string, watermark: number, count: number): ProbeRow {
  return { sessionId, agentName: 'asst', title: null, preview: null, watermark, count };
}
function cached(sessionId: string, watermark: number, count: number): CachedSession {
  return { sessionId, agentName: 'asst', title: null, preview: null, watermark, count };
}

test('an unknown session is fetched from zero', () => {
  const plan = planSync([probe('s1', 100, 10)], []);
  assert.deepEqual(plan.drop, []);
  assert.equal(plan.fetch.length, 1);
  assert.equal(plan.fetch[0].since, 0);
  assert.equal(plan.fetch[0].reset, false);
});

test('an unchanged session is left alone', () => {
  const plan = planSync([probe('s1', 100, 10)], [cached('s1', 100, 10)]);
  assert.equal(plan.fetch.length, 0);
  assert.deepEqual(plan.upToDate.map((p) => p.sessionId), ['s1']);
});

test('a moved watermark fetches the delta from the cached watermark', () => {
  const plan = planSync([probe('s1', 200, 12)], [cached('s1', 100, 10)]);
  assert.equal(plan.fetch[0].since, 100);
  assert.equal(plan.fetch[0].reset, false);
});

// The case a watermark alone cannot see: a row was deleted (dequeue /
// clearQueue), so MAX(updatedAt) is unchanged but the count dropped.
test('a shrunken count forces a wipe and a full refetch', () => {
  const plan = planSync([probe('s1', 100, 8)], [cached('s1', 100, 10)]);
  assert.equal(plan.fetch[0].reset, true);
  assert.equal(plan.fetch[0].since, 0);
});

test('a grown count at the same watermark still triggers a delta', () => {
  const plan = planSync([probe('s1', 100, 11)], [cached('s1', 100, 10)]);
  assert.equal(plan.fetch.length, 1);
  assert.equal(plan.fetch[0].reset, false);
});

test('a session the server no longer reports is dropped', () => {
  const plan = planSync([probe('s1', 100, 10)], [cached('s1', 100, 10), cached('gone', 50, 3)]);
  assert.deepEqual(plan.drop, ['gone']);
});

test('fetches are ordered newest-activity first', () => {
  const plan = planSync([probe('old', 10, 1), probe('new', 999, 1), probe('mid', 500, 1)], []);
  assert.deepEqual(plan.fetch.map((f) => f.probe.sessionId), ['new', 'mid', 'old']);
});

test('an empty probe drops everything cached', () => {
  const plan = planSync([], [cached('a', 1, 1), cached('b', 2, 2)]);
  assert.deepEqual(plan.drop.sort(), ['a', 'b']);
  assert.equal(plan.fetch.length, 0);
});
