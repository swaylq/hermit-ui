// descendantsOf is the one pure decision in killTree: given a root pid, walk the
// ps table and return every descendant. Locked down lightly because the whole
// point of killTree is that a missed child = an orphaned background shell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descendantsOf } from '@hermit-ui/tmux-driver';

test('descendantsOf always includes the root itself', () => {
  // pid 1 exists on every host; even if it has no children the result must
  // contain it and nothing else is guaranteed.
  const out = descendantsOf(1);
  assert.ok(out.includes(1));
});

test('descendantsOf returns no duplicates', () => {
  const out = descendantsOf(1);
  assert.equal(new Set(out).size, out.length);
});

test('descendantsOf of a nonexistent pid returns just that pid', () => {
  // A pid far outside any plausible range has no children and no ps row; the
  // walk must still return the root itself (killTree then no-ops on it).
  const out = descendantsOf(2 ** 30);
  assert.deepEqual(out, [2 ** 30]);
});
