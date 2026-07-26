// Noise rules for push notifications. These decide whether sway's phone buzzes,
// so the boundaries (exactly-at-the-window, exactly-at-the-hour) are the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQuietHour, localHour, shouldPush, VIEWING_WINDOW_MS } from './suppress';

const NOON = 12; // a decidedly non-quiet hour
const NIGHT = 2; // inside quiet hours

test('a plain event goes through', () => {
  assert.deepEqual(shouldPush({ kind: 'chat', hour: NOON, now: 1_000_000 }), { send: true });
});

test('viewing: a read marker inside the window suppresses', () => {
  const now = 1_000_000;
  const r = shouldPush({
    kind: 'chat',
    hour: NOON,
    now,
    lastReadAt: new Date(now - (VIEWING_WINDOW_MS - 1)),
  });
  assert.deepEqual(r, { send: false, reason: 'viewing' });
});

test('viewing: exactly at the window boundary sends', () => {
  const now = 1_000_000;
  const r = shouldPush({ kind: 'chat', hour: NOON, now, lastReadAt: new Date(now - VIEWING_WINDOW_MS) });
  assert.deepEqual(r, { send: true });
});

test('viewing beats quiet hours — an open session never buzzes', () => {
  const now = 1_000_000;
  const r = shouldPush({ kind: 'blocked', hour: NIGHT, now, lastReadAt: new Date(now - 1_000) });
  assert.deepEqual(r, { send: false, reason: 'viewing' });
});

test('a null read marker (never opened) does not suppress', () => {
  assert.deepEqual(shouldPush({ kind: 'chat', hour: NOON, now: 1_000_000, lastReadAt: null }), {
    send: true,
  });
});

test('quiet hours drop chat and cron', () => {
  for (const kind of ['chat', 'cron'] as const) {
    assert.deepEqual(
      shouldPush({ kind, hour: NIGHT, now: 1_000_000 }),
      { send: false, reason: 'quiet-hours' },
      kind,
    );
  }
});

test('quiet hours let blocked and host through', () => {
  for (const kind of ['blocked', 'host'] as const) {
    assert.deepEqual(shouldPush({ kind, hour: NIGHT, now: 1_000_000 }), { send: true }, kind);
  }
});

test('quiet window spans midnight: 23 and 07 are quiet, 08 and 22 are not', () => {
  assert.equal(isQuietHour(23), true);
  assert.equal(isQuietHour(0), true);
  assert.equal(isQuietHour(7), true);
  assert.equal(isQuietHour(8), false);
  assert.equal(isQuietHour(22), false);
});

test('localHour resolves the configured zone, not the server clock', () => {
  // 2026-07-26T16:30:00Z → 00:30 next day in UTC+8.
  const at = new Date('2026-07-26T16:30:00Z');
  assert.equal(localHour(at, 'UTC'), 16);
  assert.equal(localHour(at, 'Asia/Shanghai'), 0);
});

test('localHour renders midnight as 0, never 24', () => {
  assert.equal(localHour(new Date('2026-07-26T00:00:00Z'), 'UTC'), 0);
});
