// Noise rules for push notifications. These decide whether sway's phone buzzes,
// so the boundary (exactly-at-the-window) is the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUrgentKind,
  shouldPush,
  turnStillRunning,
  VIEWING_WINDOW_MS,
  STATE_TRUSTED_MS,
} from './suppress';
import type { PushKind } from './types';

const ALL_KINDS: PushKind[] = ['blocked', 'chat', 'cron', 'host', 'stall'];

test('a plain event goes through', () => {
  assert.deepEqual(shouldPush({ now: 1_000_000 }), { send: true });
});

test('viewing: a read marker inside the window suppresses', () => {
  const now = 1_000_000;
  const r = shouldPush({ now, lastReadAt: new Date(now - (VIEWING_WINDOW_MS - 1)) });
  assert.deepEqual(r, { send: false, reason: 'viewing' });
});

test('viewing: exactly at the window boundary sends', () => {
  const now = 1_000_000;
  assert.deepEqual(shouldPush({ now, lastReadAt: new Date(now - VIEWING_WINDOW_MS) }), {
    send: true,
  });
});

test('a null read marker (never opened) does not suppress', () => {
  assert.deepEqual(shouldPush({ now: 1_000_000, lastReadAt: null }), { send: true });
});

test('the clock never suppresses — 03:00 delivers exactly like noon', () => {
  // Quiet hours are gone. This is the regression guard: whatever the hour, an
  // event with no read marker is delivered. If someone reintroduces time-of-day
  // filtering, the notification you needed at 01:00 silently stops arriving and
  // nothing anywhere says why.
  for (const at of ['2026-07-26T03:00:00Z', '2026-07-26T12:00:00Z', '2026-07-26T23:30:00Z']) {
    assert.deepEqual(shouldPush({ now: new Date(at).getTime() }), { send: true }, at);
  }
});

test('every kind is delivered — urgency is a hint to the phone, not a filter', () => {
  for (const kind of ALL_KINDS) {
    assert.deepEqual(shouldPush({ now: 1_000_000 }), { send: true }, kind);
  }
});

test('urgent kinds are the ones worth piercing a Focus mode', () => {
  // Drives Bark's `timeSensitive` and Web Push's `Urgency: high` — and nothing
  // else, now that it no longer gates delivery.
  assert.deepEqual(ALL_KINDS.filter(isUrgentKind), ['blocked', 'host', 'stall']);
});

// ── mid-turn: the notification waits for the answer ─────────────────────────
//
// sway: "agent 要当前任务都结束回复用户了再推送消息，中间过程不用推送". The 20s
// debounce alone cannot deliver that — it assumes a turn is a burst of messages,
// and an agent on a long task goes quiet for minutes at a time INSIDE one turn
// (it is sitting in a tool). Every one of those silences used to flush a push
// carrying whatever preamble the agent happened to say before the tool.

const NOW = 1_700_000_000_000;
const fresh = new Date(NOW - 5_000);

test('a working session with a fresh snapshot holds its push', () => {
  assert.equal(turnStillRunning({ state: 'working', snapshotAt: fresh, now: NOW }), true);
});

test('every other state releases it', () => {
  for (const state of ['idle', 'starting', null, undefined]) {
    assert.equal(
      turnStillRunning({ state, snapshotAt: fresh, now: NOW }),
      false,
      String(state),
    );
  }
});

test('a gateway that stopped reporting cannot hold a notification hostage', () => {
  // Nothing in the pipeline clears a `state` of 'working', so a gateway that died
  // mid-turn says "working" for ever. Trusting that would mean the reply it
  // already delivered never reaches the lock screen, silently.
  assert.equal(
    turnStillRunning({ state: 'working', snapshotAt: new Date(NOW - STATE_TRUSTED_MS - 1), now: NOW }),
    false,
  );
  assert.equal(turnStillRunning({ state: 'working', snapshotAt: null, now: NOW }), false);
  assert.equal(turnStillRunning({ state: 'working', now: NOW }), false, 'no session row at all');
});

test('exactly at the trust boundary the state has expired', () => {
  assert.equal(
    turnStillRunning({ state: 'working', snapshotAt: new Date(NOW - (STATE_TRUSTED_MS - 1)), now: NOW }),
    true,
  );
  assert.equal(
    turnStillRunning({ state: 'working', snapshotAt: new Date(NOW - STATE_TRUSTED_MS), now: NOW }),
    false,
  );
});

test('holding is not suppressing — the two rules answer different questions', () => {
  // A held push is still going to be delivered, just later; a suppressed one never
  // is. Keeping them separate is what lets the flush re-arm on one and drop on the
  // other. Same row, mid-turn and unread: hold, do not discard.
  assert.equal(turnStillRunning({ state: 'working', snapshotAt: fresh, now: NOW }), true);
  assert.deepEqual(shouldPush({ now: NOW, lastReadAt: null }), { send: true });
});
