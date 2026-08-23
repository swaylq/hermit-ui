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
  BACKGROUND_HOLD_MAX_MS,
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

// ── background work outlives the turn that started it ───────────────────────
//
// The hole the turn gate had until 2026-08-23. Backgrounding a Bash or a
// subagent ends the turn: measured against claude 2.1.241, `result` and then
// `session_state_changed: idle` land ~1ms after the tool fires, while the task
// runs on and the model waits to be woken by it. `state` therefore says 'idle'
// for the whole of the work, and the agent's "let me kick this off" went to the
// lock screen as if it were the answer.

const bg = { kind: 'background', label: 'background', backgroundCount: 1 };

test('an idle session with background work still running holds its push', () => {
  assert.equal(turnStillRunning({ state: 'idle', snapshotAt: fresh, activity: bg, now: NOW }), true);
});

test('idle with nothing in the background still releases', () => {
  for (const activity of [null, undefined, {}, { kind: 'tool', label: 'Bash' }, { backgroundCount: 0 }]) {
    assert.equal(
      turnStillRunning({ state: 'idle', snapshotAt: fresh, activity, now: NOW }),
      false,
      JSON.stringify(activity ?? null),
    );
  }
});

test('a malformed activity payload cannot hold a notification', () => {
  // Opaque Json column: a payload from a newer gateway, or a wrong-shaped one,
  // must read as "cannot say" and fall through to delivering.
  for (const activity of ['background', 42, [], [{ backgroundCount: 3 }], { backgroundCount: '3' }]) {
    assert.equal(turnStillRunning({ state: 'idle', snapshotAt: fresh, activity, now: NOW }), false);
  }
});

test('the background hold is bounded, unlike the working hold', () => {
  // A `npm run dev` left running in the background never ends. Holding on that
  // for ever would mute the session permanently — no lock screen, for any reply,
  // for the rest of its life.
  assert.equal(
    turnStillRunning({ state: 'idle', snapshotAt: fresh, activity: bg, heldMs: BACKGROUND_HOLD_MAX_MS - 1, now: NOW }),
    true,
  );
  assert.equal(
    turnStillRunning({ state: 'idle', snapshotAt: fresh, activity: bg, heldMs: BACKGROUND_HOLD_MAX_MS, now: NOW }),
    false,
    'at the ceiling the task is read as resident, and the last word is delivered',
  );
  // The working hold keeps its promise of no ceiling.
  assert.equal(
    turnStillRunning({ state: 'working', snapshotAt: fresh, heldMs: BACKGROUND_HOLD_MAX_MS * 10, now: NOW }),
    true,
  );
});

test('a stale snapshot releases a background hold too', () => {
  // Same reason as for 'working': a gateway that has stopped reporting must not
  // be able to hold a notification for ever on the strength of its last word.
  assert.equal(
    turnStillRunning({
      state: 'idle',
      snapshotAt: new Date(NOW - STATE_TRUSTED_MS - 1),
      activity: bg,
      now: NOW,
    }),
    false,
  );
});
