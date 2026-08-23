import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSessionPutAway } from './session-put-away';

const at = (iso: string) => new Date(iso);

test('an open chat is not put away', () => {
  assert.equal(isSessionPutAway({ id: 'a', hiddenAt: null, closedAt: null }), false);
});

test('archived and hidden both count as put away', () => {
  assert.equal(isSessionPutAway({ id: 'a', closedAt: at('2026-07-01T00:00:00Z') }), true);
  assert.equal(isSessionPutAway({ id: 'b', hiddenAt: at('2026-07-01T00:00:00Z') }), true);
});

// A pin is the strongest "keep this in front of me" signal and the only one the
// server's cleanup sweep is blind to — so an archive sweep can never make a pinned
// chat vanish from a list.
test('a pin overrides both flags', () => {
  const pins = new Set(['a']);
  assert.equal(isSessionPutAway({ id: 'a', closedAt: at('2026-07-01T00:00:00Z') }, pins), false);
  assert.equal(isSessionPutAway({ id: 'b', closedAt: at('2026-07-01T00:00:00Z') }, pins), true);
});

test('it survives the serialized (string) shape the browser receives', () => {
  assert.equal(isSessionPutAway({ id: 'a', closedAt: '2026-07-01T00:00:00.000Z' }), true);
});
