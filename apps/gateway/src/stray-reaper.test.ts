// The two decisions behind the stray reaper, locked down because the incident
// this file answers was a watchdog whose every check silently never worked:
//
//   1. etimeSeconds must parse macOS ps etime CORRECTLY — the leaking script's
//      own reaper used Linux-only `etimes` (macOS ps exits 1 on it) and never
//      parsed a single age. The three real formats are mm:ss / hh:mm:ss /
//      dd-hh:mm:ss; an unparseable value must read as 0 (too young to kill),
//      never as a huge age, so a parser regression can only spare, never slay.
//
//   2. selectVictims must kill the OLD and the EXCESS — and nothing else. A
//      young-but-over-cap herd loses its oldest members; a young under-cap herd
//      loses nobody.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etimeSeconds, rootsOf, selectVictims, type StrayProc } from './stray-reaper';

test('etimeSeconds parses the three macOS etime shapes', () => {
  assert.equal(etimeSeconds('05:34'), 5 * 60 + 34); // mm:ss
  assert.equal(etimeSeconds('01:05:34'), 3600 + 5 * 60 + 34); // hh:mm:ss
  assert.equal(etimeSeconds('2-01:05:34'), 2 * 86400 + 3600 + 5 * 60 + 34); // dd-hh:mm:ss
  assert.equal(etimeSeconds('00:09'), 9);
});

test('etimeSeconds reads garbage as 0 (too young to kill, never the reverse)', () => {
  assert.equal(etimeSeconds(''), 0);
  assert.equal(etimeSeconds('abc'), 0);
  assert.equal(etimeSeconds('1-2-3'), 0);
  assert.equal(etimeSeconds('  07:12  '), 7 * 60 + 12); // ps pads fields with spaces
});

function proc(pid: number, ppid: number, ageSec: number): StrayProc {
  return { pid, ppid, ageSec, command: '/x/ms-playwright/chrome-headless-shell' };
}

test('rootsOf keeps only shells whose parent is not itself a shell', () => {
  // Two browser trees: root 100 with children 101/102, root 200 with child 201.
  const procs = [proc(100, 1, 100), proc(101, 100, 90), proc(102, 100, 80), proc(200, 1, 50), proc(201, 200, 40)];
  assert.deepEqual(
    rootsOf(procs).map((r) => r.pid),
    [100, 200],
  );
});

test('selectVictims kills everything past the age cap', () => {
  const roots = [proc(1, 0, 100), proc(2, 0, 7200), proc(3, 0, 9999)];
  assert.deepEqual(
    selectVictims(roots, 2 * 60 * 60_000, 25).map((r) => r.pid),
    [2, 3],
  );
});

test('selectVictims over the count cap kills oldest first, spares the young under cap', () => {
  // 3 roots, all young, cap 2 → exactly one dies and it is the oldest.
  const roots = [proc(1, 0, 300), proc(2, 0, 900), proc(3, 0, 600)];
  assert.deepEqual(
    selectVictims(roots, 2 * 60 * 60_000, 2).map((r) => r.pid),
    [2],
  );
  // Same herd under the cap → nobody dies.
  assert.deepEqual(selectVictims(roots, 2 * 60 * 60_000, 25), []);
});
