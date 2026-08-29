import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionStatusFrame, statusFrameSignature } from './session-status-frame';

// The signature is what decides whether a frame goes on the wire. It is a cost
// guard, not a correctness one: the client's own 5s poll still carries `state`,
// so a frame withheld is a slower dashboard, while a frame sent too often is one
// per open tab, forever, for a fact nobody asked about.

const row = (over: Record<string, unknown> = {}) => ({
  state: 'working', alive: true, activity: null,
  snapshotAt: new Date(1_000), closedAt: null, restartRequestedAt: null,
  ...over,
});

test('a rewritten snapshotAt alone is not worth a frame', () => {
  // The gateway rewrites snapshotAt every 8s for every session on the machine.
  // In the signature, that is a frame every 8s per open tab saying nothing.
  const a = sessionStatusFrame(row());
  const b = sessionStatusFrame(row({ snapshotAt: new Date(9_000) }));
  assert.equal(statusFrameSignature(a), statusFrameSignature(b));
  assert.notEqual(a.snapshotAt, b.snapshotAt, 'but the client still receives the newer one when something else moves');
});

test('a ticking elapsed clock is not worth a frame either', () => {
  const a = sessionStatusFrame(row({ activity: { kind: 'tool', label: 'Bash', elapsedSec: 3 } }));
  const b = sessionStatusFrame(row({ activity: { kind: 'tool', label: 'Bash', elapsedSec: 47 } }));
  assert.equal(statusFrameSignature(a), statusFrameSignature(b));
});

test('the turn boundary, the tool, and being archived all are', () => {
  const base = statusFrameSignature(sessionStatusFrame(row()));
  const differs = (over: Record<string, unknown>) =>
    assert.notEqual(statusFrameSignature(sessionStatusFrame(row(over))), base);
  differs({ state: 'idle' });
  differs({ alive: false });
  differs({ activity: { kind: 'tool', label: 'Bash' } });
  differs({ activity: { kind: 'tool', label: 'Bash', backgroundCount: 1 } });
  differs({ closedAt: new Date(2_000) });
  differs({ restartRequestedAt: new Date(2_000) });
});

test('dates go out as ISO strings, and absent means null rather than missing', () => {
  const f = sessionStatusFrame({ state: null, snapshotAt: new Date(0) });
  assert.equal(f.snapshotAt, new Date(0).toISOString());
  assert.equal(f.alive, false);
  assert.equal(f.activity, null);
  assert.equal(f.closedAt, null);
  // The client merges by `snapshotAt`; a key that is absent rather than null
  // would read as `undefined` and lose to the polled row forever.
  assert.deepEqual(Object.keys(f).sort(),
    ['activity', 'alive', 'closedAt', 'restartRequestedAt', 'snapshotAt', 'state']);
});
