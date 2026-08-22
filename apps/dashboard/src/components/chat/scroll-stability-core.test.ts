import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discardSubpixelDeviation,
  logicalScrollTop,
  readerScrollTop,
  settleCompensation,
} from './scroll-stability-core';

test('logical position includes the correction held by the content transform', () => {
  assert.equal(logicalScrollTop(1200, 340), 1540);
  assert.equal(logicalScrollTop(1200, -40), 1160);
});

test('anchor coordinate sees reader input but not app compensation or settlement', () => {
  // The app absorbs +340 in deviation and records the same compensation.
  assert.equal(readerScrollTop(1200, 340, 340), 1200);
  // Settling transfers it to physical scrollTop without changing that answer.
  assert.equal(readerScrollTop(1540, 0, 340), 1200);
  // A native 80px movement is still visible to the anchor.
  assert.equal(readerScrollTop(1460, 0, 340), 1120);
});

test('an unconstrained settlement transfers all deviation into scrollTop', () => {
  const x = settleCompensation(1200, 340, 0, 5000);
  assert.deepEqual(x, { wantedTop: 1540, nextTop: 1540, applied: 340, deviation: 0 });
  assert.equal(1200 + 340, x.nextTop + x.deviation, 'the visible coordinate is unchanged');
});

test('positive and negative corrections accumulate before one settlement', () => {
  const deviation = 800 - 120 + 35;
  const x = settleCompensation(1000, deviation, 0, 5000);
  assert.equal(x.applied, 715);
  assert.equal(x.deviation, 0);
});

test('a clamped settlement keeps the unpaid part in the transform', () => {
  const x = settleCompensation(10, -30, 0, 5000);
  assert.deepEqual(x, { wantedTop: -20, nextTop: 0, applied: -10, deviation: -20 });
  assert.equal(10 - 30, x.nextTop + x.deviation, 'clamping cannot move the visible content');
});

test('discarding a subpixel transform preserves the reader-only coordinate', () => {
  const before = readerScrollTop(1200, 0.6, 340.6);
  const normalized = discardSubpixelDeviation(0.6, 340.6, 1);
  assert.deepEqual(normalized, { deviation: 0, compensated: 340 });
  assert.ok(Math.abs(readerScrollTop(1200, normalized.deviation, normalized.compensated) - before) < 1e-9);
  assert.deepEqual(discardSubpixelDeviation(-1, 20, 1), { deviation: -1, compensated: 20 });
});
