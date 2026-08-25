import test from 'node:test';
import assert from 'node:assert/strict';
import { loopStateForSession } from './loop-state';

const ME = 'sess-me';
const other = { id: 'a', ownerSessionId: 'sess-other', lastResult: 'x'.repeat(200) };
const mine = { id: 'b', ownerSessionId: ME };
const legacy = { id: 'c' };

test('keeps this session\'s loops and drops the siblings\'', () => {
  const out = loopStateForSession({ loops: [other, mine], schedules: [] }, ME) as { loops: unknown[] };
  assert.deepEqual(out.loops, [mine]);
});

test('a loop with no owner is legacy and stays visible everywhere', () => {
  const out = loopStateForSession({ loops: [other, legacy], schedules: [] }, ME) as { loops: unknown[] };
  assert.deepEqual(out.loops, [legacy]);
});

test('schedules are agent-level and are not touched', () => {
  const schedules = [{ id: 'cron-1' }];
  const out = loopStateForSession({ loops: [other], schedules }, ME) as { schedules: unknown[] };
  assert.deepEqual(out.schedules, schedules);
});

test('nothing to trim returns the very same object', () => {
  const raw = { loops: [mine, legacy], schedules: [] };
  assert.equal(loopStateForSession(raw, ME), raw);
});

test('anything that is not a loop-state object passes straight through', () => {
  for (const raw of [null, undefined, 42, 'text', [1, 2], {}, { loops: 'not an array' }]) {
    assert.equal(loopStateForSession(raw, ME), raw);
  }
});

test('a non-object entry is passed through, exactly as the client did', () => {
  // LoopBar reads `l.ownerSessionId` off whatever is in the array; on a string
  // that is undefined, so it kept it. Dropping it here would be a behaviour
  // change disguised as a cleanup.
  const out = loopStateForSession({ loops: ['junk', other], schedules: [] }, ME) as { loops: unknown[] };
  assert.deepEqual(out.loops, ['junk']);
});
