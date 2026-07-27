// The limits that make it safe to hand the Brain a live conversation. These decide
// when it stops talking on someone's behalf, so the boundaries — exactly at the cap,
// exactly at the clock — are the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAKEOVER_MAX_AGE_MS,
  TAKEOVER_TURN_CAP,
  checkLimits,
  endNote,
  startNote,
} from './takeover';

const NOW = 1_800_000_000_000;
const fresh = (turns: number, ageMs = 0) => ({
  takeoverTurns: turns,
  takeoverStartedAt: new Date(NOW - ageMs),
});

test('a takeover with room left is allowed to continue', () => {
  assert.deepEqual(checkLimits(fresh(0), NOW), { over: false });
  assert.deepEqual(checkLimits(fresh(TAKEOVER_TURN_CAP - 1), NOW), { over: false });
});

test('the turn cap trips exactly AT the cap, not after it', () => {
  // takeoverTurns counts messages already sent, so at === cap the next one would be
  // number cap+1. Off-by-one here is the difference between 12 and 13 messages.
  assert.deepEqual(checkLimits(fresh(TAKEOVER_TURN_CAP), NOW), { over: true, reason: 'turns' });
});

test('a Brain that somehow overshot is still stopped', () => {
  assert.deepEqual(checkLimits(fresh(TAKEOVER_TURN_CAP + 5), NOW), { over: true, reason: 'turns' });
});

test('the age cap trips exactly at the ceiling', () => {
  assert.deepEqual(checkLimits(fresh(0, TAKEOVER_MAX_AGE_MS - 1), NOW), { over: false });
  assert.deepEqual(checkLimits(fresh(0, TAKEOVER_MAX_AGE_MS), NOW), { over: true, reason: 'age' });
});

test('turns are reported before age when both have tripped', () => {
  // Not arbitrary: the end-of-takeover note tells the human WHY it stopped, and
  // "used all its messages" is the more actionable of the two.
  assert.deepEqual(
    checkLimits(fresh(TAKEOVER_TURN_CAP, TAKEOVER_MAX_AGE_MS * 2), NOW),
    { over: true, reason: 'turns' },
  );
});

test('a missing start time disables the age cap without breaking the turn cap', () => {
  // takeoverStartedAt is null when the row isn't in a takeover at all; callers check
  // that separately, so this must not throw or spuriously report an age overrun.
  assert.deepEqual(checkLimits({ takeoverTurns: 0, takeoverStartedAt: null }, NOW), { over: false });
  assert.deepEqual(
    checkLimits({ takeoverTurns: TAKEOVER_TURN_CAP, takeoverStartedAt: null }, NOW),
    { over: true, reason: 'turns' },
  );
});

test('every end reason produces a distinct, human-readable note', () => {
  const notes = (['done', 'turns', 'age', 'human', 'closed'] as const).map((r) => endNote(r));
  for (const n of notes) assert.ok(n.startsWith('[takeover] '), n);
  assert.equal(new Set(notes).size, notes.length, 'reasons must be distinguishable in the transcript');
});

test('the cap notes name the actual limits, so the numbers can never drift from the code', () => {
  assert.match(endNote('turns'), new RegExp(String(TAKEOVER_TURN_CAP)));
  assert.match(endNote('age'), new RegExp(String(Math.round(TAKEOVER_MAX_AGE_MS / 60_000))));
});

test("the Brain's summary is appended to the end note", () => {
  const note = endNote('done', '  Fixed the failing test and pushed.  ');
  assert.match(note, /Fixed the failing test and pushed\./);
  assert.ok(!note.includes('  Fixed'), 'summary should be trimmed');
});

test('an empty or whitespace summary adds nothing', () => {
  assert.equal(endNote('done', '   '), endNote('done'));
  assert.equal(endNote('done', null), endNote('done'));
});

test('end notes stay within the appendSystemNote length limit', () => {
  // System rows cap at 500 chars server-side; a Brain summary at its own 500-char
  // limit must not push the note past that and get rejected.
  assert.ok(endNote('done', 'x'.repeat(900)).length <= 500);
});

test('the start note tells the human how to take the conversation back', () => {
  // Typing is the escape hatch, and it's only discoverable if we say so.
  assert.match(startNote(), /take it back/i);
});
