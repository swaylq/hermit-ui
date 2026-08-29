import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyTurnBoundary, resetTurnBoundaryListeners } from '../runtime/turn-boundary';
import { startSessionStatePush, _resetSessionStatePush, _COALESCE_MS } from './session-state-push';

// These are about COST, not correctness of the state itself: the 8s snapshot
// still carries the truth a moment later, so the only way this feature can hurt
// is by turning two events per turn into a stream of requests, or by writing
// null over the columns the 8s tick owns.

const settle = () => new Promise((r) => setTimeout(r, _COALESCE_MS + 40));

function harness() {
  resetTurnBoundaryListeners();
  _resetSessionStatePush();
  const batches: any[][] = [];
  startSessionStatePush(async (items) => { batches.push(items as any[]); });
  return batches;
}

test('a turn start and its confirming frame cost one request, not two', async () => {
  const batches = harness();
  // submit() announces, then the CLI's own `running` frame announces the same
  // thing under a millisecond later. Measured order; both must not go on the wire.
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: null });
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: null });
  await settle();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[0][0].state, 'working');
});

test('an unchanged boundary sends nothing at all', async () => {
  const batches = harness();
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: null });
  await settle();
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: null });
  await settle();
  assert.equal(batches.length, 1, 'the second says exactly what the first already did');
});

test('a ticking elapsed clock is not a change', async () => {
  const batches = harness();
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: { kind: 'tool', label: 'Bash', elapsedSec: 3 } });
  await settle();
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: { kind: 'tool', label: 'Bash', elapsedSec: 4 } });
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: { kind: 'tool', label: 'Bash', elapsedSec: 5 } });
  await settle();
  assert.equal(batches.length, 1, 'one request per second of a long Bash is the bug this guards');
});

test('a different tool IS a change', async () => {
  const batches = harness();
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: { kind: 'tool', label: 'Bash' } });
  await settle();
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: { kind: 'tool', label: 'Read' } });
  await settle();
  assert.equal(batches.length, 2);
});

test('sessions that flip together travel in one batch', async () => {
  const batches = harness();
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: null });
  notifyTurnBoundary({ sessionId: 's2', working: true, activity: null });
  notifyTurnBoundary({ sessionId: 's3', working: false, activity: null });
  await settle();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
});

test('every item is partial — the 8s tick owns the columns this cannot see', async () => {
  const batches = harness();
  notifyTurnBoundary({ sessionId: 's1', working: false, activity: null });
  await settle();
  const item = batches[0][0];
  assert.equal(item.partial, true);
  // Without `partial`, the sync route writes null for every key an item omits,
  // so a turn boundary would blank the transcript path and both prompt snippets.
  assert.deepEqual(Object.keys(item).sort(), ['activity', 'alive', 'partial', 'sessionId', 'state']);
  assert.equal(item.state, 'idle');
});

test('a failed POST is retried on the next boundary rather than remembered as sent', async () => {
  resetTurnBoundaryListeners();
  _resetSessionStatePush();
  const seen: string[] = [];
  let fail = true;
  startSessionStatePush(async (items) => {
    seen.push((items as any[])[0].state);
    if (fail) { fail = false; throw new Error('dashboard down'); }
  });
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: null });
  await settle();
  notifyTurnBoundary({ sessionId: 's1', working: true, activity: null });
  await settle();
  assert.deepEqual(seen, ['working', 'working']);
});
