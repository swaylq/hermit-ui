import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptableCompensation,
  contentHeight,
  discardSubpixelDeviation,
  isVerticalWheelInput,
  logicalScrollTop,
  planBoundaryRebase,
  readerMovedUp,
  readerScrollTop,
  settleCompensation,
  trimOutOfRangeDeviation,
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


test('content height is read off the layer, because WebKit latches scrollHeight', () => {
  // Measured on the live dashboard, WebKit 390x844: natural content 3750px,
  // viewport 652px, and the scroller's own number after each transform value
  // change in order — 0, -500, -300, -700, +200, -200, 0. It recomputes when
  // the transform is added and when it is removed, and not in between.
  const layerHeight = 3750;
  for (const scrollHeight of [3750, 4250, 4250, 4250, 4250, 4250, 3750]) {
    assert.equal(contentHeight({ layerHeight, scrollHeight, clientHeight: 652 }), 3750);
  }
  // No layer to read (nothing mounted yet): the scroller is all there is.
  assert.equal(contentHeight({ layerHeight: 0, scrollHeight: 1200, clientHeight: 652 }), 1200);
  // Never less than one viewport, however short the conversation.
  assert.equal(contentHeight({ layerHeight: 100, scrollHeight: 652, clientHeight: 652 }), 652);
});

test('a latched scrollHeight would unpin a reader standing on the end', () => {
  // The WebKit state: natural content 3750, viewport 652, and scrollHeight
  // latched at 4250 by an earlier downward correction that has since changed
  // value. This is what the two consumers of the number do with it.
  const layerHeight = 3750;
  const clientHeight = 652;
  const latched = 4250;
  const atTheTail = layerHeight - clientHeight;
  const honest = contentHeight({ layerHeight, scrollHeight: latched, clientHeight });

  // The pin detector re-pins inside 60px of the end and shows "↓ latest" past
  // it. Honest: the reader is on the end. Raw: 500px short of an end they are
  // standing on, so they are unpinned and the pill appears.
  assert.equal(honest - atTheTail - clientHeight, 0);
  assert.equal(latched - atTheTail - clientHeight, 500);

  // Same 500px from the other side: a scroll-to-bottom aimed with the raw value
  // overshoots into blank — and the physical range, latched by the same
  // transform, is happy to accept it.
  assert.equal(honest - clientHeight, atTheTail);
  assert.equal(latched - clientHeight, atTheTail + 500);
});

test('compensation stops at the ends of the content, as a scrollTop write did', () => {
  // Room to move: taken in full.
  assert.equal(acceptableCompensation({
    scrollTop: 400, deviation: 0, delta: -200, minTop: 0, maxTop: 1038,
  }), -200);
  // The exact frame that started the oscillation: the tail anchor read a
  // clamped scrollTop as 697px of upward reader input and asked to undo it,
  // from a viewport already at the top.
  assert.equal(acceptableCompensation({
    scrollTop: 0, deviation: 0, delta: -697, minTop: 0, maxTop: 1038,
  }), 0);
  // Partial: only the distance left to the end is accepted, and the caller
  // adopts the rest through settledHold.
  assert.equal(acceptableCompensation({
    scrollTop: 900, deviation: 0, delta: 500, minTop: 0, maxTop: 1038,
  }), 138);
  // Deviation counts as part of where the reader already is.
  assert.equal(acceptableCompensation({
    scrollTop: 0, deviation: 900, delta: 500, minTop: 0, maxTop: 1038,
  }), 138);
  // A boundary hold (746e650) is inside the range and must pass untouched.
  assert.equal(acceptableCompensation({
    scrollTop: 0, deviation: 3000, delta: 500, minTop: 0, maxTop: 40000,
  }), 500);
  // Content shorter than the viewport: nowhere to go, and no negative range.
  assert.equal(acceptableCompensation({
    scrollTop: 0, deviation: 0, delta: -300, minTop: 0, maxTop: 0,
  }), 0);
});

test('a correction is never returned against the direction that asked for it', () => {
  // Already outside the range — a fling to a physical end while a correction is
  // held, which no rebase rule pulls back. A scrollTop write would have moved
  // at most `delta` and never against it; snapping back into range instead
  // would both jump the reader and, through settledHold, corrupt the hold.
  //
  // 400px of blank above the first message, asked to go further up: refuse.
  assert.equal(acceptableCompensation({
    scrollTop: 0, deviation: -400, delta: -100, minTop: 0, maxTop: 697,
  }), 0);
  // From the same place, asked to come down 300: exactly 300, not the 400 that
  // would land back in range.
  assert.equal(acceptableCompensation({
    scrollTop: 0, deviation: -400, delta: 300, minTop: 0, maxTop: 697,
  }), 300);
  // Past the end with an upward correction held, asked to go further down.
  assert.equal(acceptableCompensation({
    scrollTop: 697, deviation: 500, delta: 50, minTop: 0, maxTop: 697,
  }), 0);
  assert.equal(acceptableCompensation({
    scrollTop: 697, deviation: 500, delta: -50, minTop: 0, maxTop: 697,
  }), -50);
});

// --- trimOutOfRangeDeviation ------------------------------------------------

test('a deviation that fits inside the range is left alone', () => {
  assert.equal(trimOutOfRangeDeviation({ scrollTop: 500, deviation: -348, minTop: 0 }), 0);
  assert.equal(trimOutOfRangeDeviation({ scrollTop: 0, deviation: 0, minTop: 0 }), 0);
});

test('a positive deviation at the top is planBoundaryRebase business, not this', () => {
  // scrollTop 0 with deviation +400 is the case a single setter call fixes.
  assert.equal(trimOutOfRangeDeviation({ scrollTop: 0, deviation: 400, minTop: 0 }), 0);
});

test('scrolling into space the transform invented gives that space back', () => {
  // The reader has 100px of physical runway left but the deviation claims 348.
  assert.equal(trimOutOfRangeDeviation({ scrollTop: 100, deviation: -348, minTop: 0 }), 248);
  // At the very top the whole thing is surrendered.
  assert.equal(trimOutOfRangeDeviation({ scrollTop: 0, deviation: -348, minTop: 0 }), 348);
});

test('the trim never overshoots past zero deviation', () => {
  const t = trimOutOfRangeDeviation({ scrollTop: 0, deviation: -50, minTop: 0 });
  assert.equal(t, 50);
  assert.equal(-50 + t, 0, 'deviation lands exactly on zero, never positive');
});

test('trimming step by step converges to the same place as one drop', () => {
  let scrollTop = 348;
  let deviation = -348;
  // The reader walks the last 348px to the top, 60px at a time.
  for (let i = 0; i < 20 && scrollTop > 0; i++) {
    scrollTop = Math.max(0, scrollTop - 60);
    deviation += trimOutOfRangeDeviation({ scrollTop, deviation, minTop: 0 });
  }
  assert.equal(scrollTop, 0);
  assert.equal(deviation, 0, 'nothing is left for commitDeviation to discard');
});
