import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discardSubpixelDeviation,
  isVerticalWheelInput,
  logicalScrollTop,
  planBoundaryRebase,
  readerMovedUp,
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

test('sub-2px WebKit scroll events still reveal upward reader intent', () => {
  let previous = 1200;
  for (let i = 0; i < 80; i++) {
    const current = previous - 1;
    assert.equal(readerMovedUp(previous, current), true, `1px event ${i} must not disappear into a deadband`);
    previous = current;
  }
  assert.equal(readerMovedUp(previous, previous), false);
  assert.equal(readerMovedUp(previous, previous + 1), false);
});

test('only a vertical wheel gesture is allowed to spend timeline runway', () => {
  assert.equal(isVerticalWheelInput(0, -90, false), true);
  assert.equal(isVerticalWheelInput(2, -90, false), true);
  assert.equal(isVerticalWheelInput(90, -2, false), false, 'horizontal swipe jitter is ignored');
  assert.equal(isVerticalWheelInput(0, -90, true), false, 'Ctrl+wheel is browser pinch zoom');
  assert.equal(isVerticalWheelInput(90, 0, false), false);
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

test('positive deviation is atomically rebased when native upward input exhausts the top runway', () => {
  // A prepend landed while the reader was 30px from the physical top. Native
  // input consumed those 30px, but 2200px of logical history remains above the
  // viewport in the transform and cannot be reached while physical top is zero.
  const plan = planBoundaryRebase({
    scrollTop: 0,
    deviation: 2200,
    minTop: 0,
    maxTop: 5000,
    readerDelta: -120,
  });
  assert.deepEqual(plan, {
    wantedTop: 2200,
    nextTop: 2200,
    applied: 2200,
    deviation: 0,
  });
  assert.equal(0 + 2200, plan!.nextTop + plan!.deviation, 'the atomic rebase cannot move visible content');
  assert.equal(
    readerScrollTop(0, 2200, 2200),
    readerScrollTop(plan!.nextTop, plan!.deviation, 2200),
    'the same atomic rebase cannot impersonate reader movement',
  );
});

test('negative deviation is atomically rebased when native downward input exhausts the bottom runway', () => {
  const plan = planBoundaryRebase({
    scrollTop: 5000,
    deviation: -1200,
    minTop: 0,
    maxTop: 5000,
    readerDelta: 120,
  });
  assert.deepEqual(plan, {
    wantedTop: 3800,
    nextTop: 3800,
    applied: -1200,
    deviation: 0,
  });
  assert.equal(5000 - 1200, plan!.nextTop + plan!.deviation, 'the symmetric rebase cannot move visible content');
  assert.equal(
    readerScrollTop(5000, -1200, -1200),
    readerScrollTop(plan!.nextTop, plan!.deviation, -1200),
    'the symmetric rebase also preserves the reader-only coordinate',
  );
});

test('a boundary rebase transfers only the debt the current scroll range can hold', () => {
  const plan = planBoundaryRebase({
    scrollTop: 0,
    deviation: 7000,
    minTop: 0,
    maxTop: 5000,
    readerDelta: -120,
  });
  assert.deepEqual(plan, {
    wantedTop: 7000,
    nextTop: 5000,
    applied: 5000,
    deviation: 2000,
  });
  assert.equal(7000, plan!.nextTop + plan!.deviation, 'clamping keeps the unpaid transform visible');
  assert.equal(planBoundaryRebase({
    scrollTop: plan!.nextTop,
    deviation: plan!.deviation,
    minTop: 0,
    maxTop: 5000,
    readerDelta: -120,
  }), null, 'one edge input cannot turn into a repeated setter after runway is restored');
});

test('held compensation is not rebased while physical native runway remains', () => {
  assert.equal(planBoundaryRebase({
    scrollTop: 30,
    deviation: 2200,
    minTop: 0,
    maxTop: 5000,
    readerDelta: -120,
  }), null);
  assert.equal(planBoundaryRebase({
    scrollTop: 4970,
    deviation: -1200,
    minTop: 0,
    maxTop: 5000,
    readerDelta: 120,
  }), null);
});

test('a boundary does not rebase debt that cannot block the requested direction', () => {
  assert.equal(planBoundaryRebase({
    scrollTop: 0,
    deviation: 2200,
    minTop: 0,
    maxTop: 5000,
    readerDelta: 120,
  }), null);
  assert.equal(planBoundaryRebase({
    scrollTop: 5000,
    deviation: -1200,
    minTop: 0,
    maxTop: 5000,
    readerDelta: -120,
  }), null);
});
