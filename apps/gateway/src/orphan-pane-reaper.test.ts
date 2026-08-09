// Which panes the orphan sweep is allowed to kill.
//
// This is the one function in session cleanup that ends a live process with no
// undo and no DB row to reconstruct from, so the tests are written from the
// question "what would make it kill something it shouldn't" rather than from the
// happy path. Three ways that could happen, one test each:
//
//   1. the known-set is empty or partial because a request failed → kill everything
//   2. a pane exists before its row is visible → kill a session being born
//   3. the pane-name derivation drifts from tmux-driver's → nothing matches, so
//      every live pane reads as an orphan
//
// The 2026-08-09 mac001 reading (13 orphans, 1.54 GB) is what the sweep is FOR;
// killing a fourteenth pane that was doing something is what it must never do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmuxPaneName, type TmuxSessionInfo } from '@hermit-ui/tmux-driver';
import { selectOrphanPanes } from './orphan-pane-reaper';

const NOW = new Date('2026-08-09T12:00:00Z').getTime();
const HOUR = 3_600_000;
const GRACE = 2 * HOUR;

// Real cuids from the machine, so the last-12 pane-name rule is exercised on the
// shape it actually sees rather than on a convenient 12-char string.
const LIVE = 'cmsleq58o000zpvog6fnikwy0';
const OTHER = 'cms4aadiz19chpvjm6gnmkvuh';

function pane(name: string, agedHours: number): TmuxSessionInfo {
  return { name, createdAt: NOW - agedHours * HOUR, activityAt: NOW - agedHours * HOUR };
}

test('a pane with no row, quiet past the grace, is an orphan', () => {
  const panes = [pane('hermit-deadbeef0001', 24)];
  const picked = selectOrphanPanes(panes, [LIVE], NOW, GRACE);
  assert.deepEqual(picked.map((p) => p.name), ['hermit-deadbeef0001']);
});

test('a pane whose session still exists is never touched', () => {
  const panes = [pane(tmuxPaneName(LIVE), 24)];
  assert.deepEqual(selectOrphanPanes(panes, [LIVE], NOW, GRACE), []);
});

test('pane names are matched the way tmux-driver builds them, not by raw id', () => {
  // The pane is named after the LAST 12 chars of the cuid. Matching on the whole
  // id would find nothing here — and "nothing matches" means "everything is an
  // orphan", i.e. the sweep would kill every live session on the host.
  const name = tmuxPaneName(LIVE);
  assert.equal(name, 'hermit-pvog6fnikwy0');
  assert.notEqual(name, `hermit-${LIVE}`);
  assert.deepEqual(selectOrphanPanes([pane(name, 48)], [LIVE, OTHER], NOW, GRACE), []);
});

test('an empty known-set kills nothing — missing evidence is not evidence of absence', () => {
  const panes = [pane('hermit-aaaa00000001', 72), pane('hermit-bbbb00000002', 72)];
  assert.deepEqual(selectOrphanPanes(panes, [], NOW, GRACE), []);
});

test('a freshly created pane is spared even with no row yet', () => {
  // The row lands before the pane is spawned, so this is margin rather than a
  // real race — but it is the margin that makes a create/sync hiccup harmless.
  assert.deepEqual(selectOrphanPanes([pane('hermit-newborn00001', 0.1)], [LIVE], NOW, GRACE), []);
});

test('both clocks must be past the grace, not just one', () => {
  // Created long ago but active a minute ago: someone is in there.
  const busyOldPane: TmuxSessionInfo = {
    name: 'hermit-oldbutbusy01',
    createdAt: NOW - 72 * HOUR,
    activityAt: NOW - 60_000,
  };
  assert.deepEqual(selectOrphanPanes([busyOldPane], [LIVE], NOW, GRACE), []);
});

test('the batch is capped, oldest-quiet first', () => {
  const panes = Array.from({ length: 25 }, (_, i) => ({
    name: `hermit-orphan${String(i).padStart(6, '0')}`,
    createdAt: NOW - 100 * HOUR,
    // i=0 quietest.
    activityAt: NOW - (100 - i) * HOUR,
  }));
  const picked = selectOrphanPanes(panes, [LIVE], NOW, GRACE, 10);
  assert.equal(picked.length, 10);
  assert.equal(picked[0].name, 'hermit-orphan000000');
  assert.equal(picked[9].name, 'hermit-orphan000009');
});
