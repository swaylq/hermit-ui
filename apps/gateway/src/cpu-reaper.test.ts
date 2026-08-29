// Locking down the two decisions that could otherwise make this watcher either
// never fire (a silent bug, like the incident script's own `jobs -p`) or slay a
// legitimate job:
//
//   1. cpuTimeSeconds must parse macOS ps time (mm:ss / hh:mm:ss / dd-hh:mm:ss)
//      and read garbage as 0 — a parser regression can only spare, never slay.
//
//   2. isPinned must demand BOTH accumulated age AND core-fraction sustained
//      over confirm consecutive intervals. A short CPU spike is never a kill;
//      neither is a process that accumulated hours once but is now idle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuTimeSeconds, isPinned, isSkip } from './cpu-reaper';

test('cpuTimeSeconds parses the three macOS ps time shapes', () => {
  assert.equal(cpuTimeSeconds('05:34'), 5 * 60 + 34); // mm:ss
  assert.equal(cpuTimeSeconds('01:05:34'), 3600 + 5 * 60 + 34); // hh:mm:ss
  assert.equal(cpuTimeSeconds('2-01:05:34'), 2 * 86400 + 3600 + 5 * 60 + 34); // dd-hh:mm:ss
  assert.equal(cpuTimeSeconds('  07:12  '), 7 * 60 + 12); // ps pads fields with spaces
});

test('cpuTimeSeconds reads garbage as 0 (too young to kill, never the reverse)', () => {
  assert.equal(cpuTimeSeconds(''), 0);
  assert.equal(cpuTimeSeconds('abc'), 0);
  assert.equal(cpuTimeSeconds('1-2-3'), 0);
});

test('isPinned requires enough samples first', () => {
  // 2 samples, confirm 3 → not enough history.
  const s = [
    { cpuSec: 0, at: 0 },
    { cpuSec: 300, at: 300_000 },
  ];
  assert.equal(isPinned(s, 120 * 60, 0.9, 3), false);
});

test('isPinned requires accumulated age', () => {
  // 4 samples at 100% of a core, but only 4 minutes of accumulated CPU.
  const s = [0, 60, 120, 180].map((cpuSec, i) => ({ cpuSec, at: i * 60_000 }));
  assert.equal(isPinned(s, 120 * 60, 0.9, 3), false);
});

test('isPinned fires on a true pinned orphan (the 2026-08-29 shape)', () => {
  // 3h accumulated, last 3 intervals each at 95% of one core.
  const s = [0, 300, 600, 900, 1200].map((cpuSec, i) => ({ cpuSec: cpuSec + 3 * 3600, at: i * 300_000 }));
  assert.equal(isPinned(s, 120 * 60, 0.9, 3), true);
});

test('isPinned spares a process that went quiet (accumulated once, now idle)', () => {
  // 3h accumulated, but the last intervals add almost no CPU.
  const s = [0, 1, 2, 3, 4].map((cpuSec, i) => ({ cpuSec: cpuSec + 3 * 3600, at: i * 300_000 }));
  assert.equal(isPinned(s, 120 * 60, 0.9, 3), false);
});

test('isPinned spares a burst that is not sustained', () => {
  // One hot interval (100%) flanked by idle ones — not confirm in a row.
  const s = [
    { cpuSec: 3600, at: 0 },
    { cpuSec: 3600, at: 300_000 },
    { cpuSec: 3900, at: 600_000 },
    { cpuSec: 3900, at: 900_000 },
  ];
  assert.equal(isPinned(s, 120 * 60, 0.9, 3), false);
});

test('isSkip covers system paths and our own runtime, not a bare loop', () => {
  assert.equal(isSkip('/sbin/launchd'), true);
  assert.equal(isSkip('/usr/libexec/opendirectoryd'), true);
  assert.equal(isSkip('node /Users/sway003/hermit-ui/apps/gateway/src/index.ts'), true);
  assert.equal(isSkip('/usr/local/bin/claude --dangerously-skip-permissions'), true);
  assert.equal(isSkip('/bin/zsh -c while :; do :; done'), false);
  assert.equal(isSkip('node /Users/sway003/zhinan-nas-dev/refs/src/batch-extract.mjs'), false);
});
