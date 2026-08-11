import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionRecencyAt, sessionRecencyMs } from './session-recency';

const at = (iso: string) => new Date(iso);

test('a spoken-to session is placed by its last message', () => {
  const s = { lastMessageAt: at('2026-08-11T06:00:00Z'), startedAt: at('2026-06-01T00:00:00Z') };
  assert.equal(sessionRecencyAt(s), s.lastMessageAt);
  assert.equal(sessionRecencyMs(s), s.lastMessageAt.getTime());
});

test('a session created but never messaged falls back to when it started', () => {
  const s = { lastMessageAt: null, startedAt: at('2026-08-10T09:00:00Z') };
  assert.equal(sessionRecencyAt(s), s.startedAt);
  assert.equal(sessionRecencyMs(s), s.startedAt.getTime());
});

// The bug this key exists to prevent. `lastMessageAt DESC NULLS LAST` filed a chat
// created yesterday BELOW conversations last spoken to two months ago, while the row
// it produced read "1d ago" — the sidebar's list ended with its newest session.
test('a new never-messaged session outranks an old spoken-to one', () => {
  const fresh = { lastMessageAt: null, startedAt: at('2026-08-10T09:00:00Z') };
  const stale = { lastMessageAt: at('2026-06-14T12:00:00Z'), startedAt: at('2026-06-11T10:00:00Z') };
  const sorted = [stale, fresh].sort((a, b) => sessionRecencyMs(b) - sessionRecencyMs(a));
  assert.deepEqual(sorted, [fresh, stale]);
});

test('the key survives the serialized (string) shape the browser receives', () => {
  const s = { lastMessageAt: null, startedAt: '2026-08-10T09:00:00.000Z' };
  assert.equal(sessionRecencyMs(s), Date.parse('2026-08-10T09:00:00.000Z'));
  const t = { lastMessageAt: '2026-08-11T06:00:00.000Z', startedAt: '2026-06-01T00:00:00.000Z' };
  assert.equal(sessionRecencyMs(t), Date.parse('2026-08-11T06:00:00.000Z'));
});

// `undefined` and `null` both mean "no message yet": the tRPC row carries null, while a
// caller passing a narrowed object may simply omit the field.
test('an absent lastMessageAt is treated the same as a null one', () => {
  const s = { startedAt: at('2026-08-10T09:00:00Z') };
  assert.equal(sessionRecencyMs(s), s.startedAt.getTime());
});
