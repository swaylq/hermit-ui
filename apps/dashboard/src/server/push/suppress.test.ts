// Noise rules for push notifications. These decide whether sway's phone buzzes,
// so the boundary (exactly-at-the-window) is the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUrgentKind, shouldPush, VIEWING_WINDOW_MS } from './suppress';
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
