// What a takeover says when it ends. The caps that used to live here are gone — a
// takeover now runs until the goal is met, the safety floor is hit, or the human
// takes it back — so what's left to protect is the transcript: whoever reads this
// conversation later has to be able to tell why the Brain stopped driving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAKEOVER_CONCURRENCY, endNote, startNote } from './takeover';

test('every end reason produces a distinct, human-readable note', () => {
  const notes = (['done', 'human', 'closed'] as const).map((r) => endNote(r));
  for (const n of notes) assert.ok(n.startsWith('[takeover] '), n);
  assert.equal(new Set(notes).size, notes.length, 'reasons must be distinguishable in the transcript');
});

test('no end note claims a limit was reached — there are none left to reach', () => {
  for (const r of ['done', 'human', 'closed'] as const) {
    assert.doesNotMatch(endNote(r), /limit|minute|message budget/i, r);
  }
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
  // Typing is the escape hatch, and with no time or turn limit behind it, it is the
  // ONLY thing that reliably ends a takeover the human no longer wants. It has to be
  // discoverable, so it is stated in the transcript itself.
  assert.match(startNote(), /take it back/i);
});

test('concurrency stays bounded — it guards the host, not the Brain', () => {
  // Each takeover holds a live claude process. This is the one number that must not
  // quietly become unlimited along with the rest.
  assert.ok(Number.isInteger(TAKEOVER_CONCURRENCY) && TAKEOVER_CONCURRENCY > 0);
  assert.ok(TAKEOVER_CONCURRENCY <= 32, 'a burst of handovers must not be able to OOM the machine');
});
