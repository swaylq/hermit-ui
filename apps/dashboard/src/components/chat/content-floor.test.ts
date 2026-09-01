import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOOR_FRAMES,
  ageContentFloor,
  raiseContentFloor,
  type ContentFloor,
} from './scroll-stability-core';
import { planTailFrame, type BottomHold } from './prepend-anchor-core';

// The open this exists for, replayed from the live trace (dash.swaylab.ai,
// WebKit 390x844, warm cache, session 财务报表筛选与统计, three opens in three):
//
//   t=344  10 rows, layer 1938, scrollTop 1046, tail hold taken, held at 0
//   t=366  eight older rows land; React re-inserts the four rows below them, so
//          the layer measures 958 mid-commit -> scrollTop comes back 66
//   t=376  20 rows, layer 2409 — the reader is now 1,451px above the end
//
// The clamp is the whole bug: the page reads those 980px as the reader deciding
// to go and read history, drops the bottom pin, and the tail hold is abandoned.

const CLIENT = 688;
/** Correction the anchor was already holding as a transform when it happened. */
const DEVIATION = 204;
const AT_END = 1046;
const LAYOUTS = [1938, 958, 2409];

/**
 * What WebKit does with `scrollTop` on each layout: the range it clamps into is
 * the LAID-OUT layer, minus the upward translate the anchor is holding, minus
 * the viewport. `floor` is the `min-height` we may have put on the layer, and
 * the engine cannot see the difference between that and content.
 */
function clampThrough(layouts: number[], floor: number): number {
  let top = AT_END;
  for (const laidOut of layouts) {
    const box = Math.max(laidOut, floor);
    top = Math.min(top, Math.max(0, box - DEVIATION - CLIENT));
  }
  return top;
}

test('without a floor the mid-commit layout clamps the reader off the end', () => {
  assert.equal(clampThrough(LAYOUTS, 0), 66);
});

test('a floor measured before the commit keeps the reader at the end', () => {
  const floor = raiseContentFloor(null, { measured: 1938, rowsBefore: 10, rowsAfter: 18 });
  assert.ok(floor);
  assert.equal(clampThrough(LAYOUTS, floor.height), AT_END);
});

test('the clamp is what makes the tail hold abandon a reader who never left', () => {
  const hold: BottomHold = { gap: 0, lastTop: AT_END, peak: 1938 };
  const clamped = clampThrough(LAYOUTS, 0);
  const plan = planTailFrame(hold, {
    readerTop: clamped,
    scrollTop: clamped + DEVIATION,
    scrollHeight: 2409,
    clientHeight: CLIENT,
    maxTop: 2409 - CLIENT,
    slack: 60,
  });
  // 980px of movement nobody made, booked as the reader's own.
  assert.equal(Math.round(plan.gap), 980);
  assert.equal(plan.abandon, true);

  const floor = raiseContentFloor(null, { measured: 1938, rowsBefore: 10, rowsAfter: 18 });
  const held = clampThrough(LAYOUTS, floor!.height);
  const kept = planTailFrame(hold, {
    readerTop: held,
    scrollTop: held + DEVIATION,
    scrollHeight: 2409,
    clientHeight: CLIENT,
    maxTop: 2409 - CLIENT,
    slack: 60,
  });
  assert.equal(kept.gap, 0);
  assert.equal(kept.abandon, false);
});

test('only a commit that adds rows raises a floor', () => {
  const measured = 1938;
  assert.equal(raiseContentFloor(null, { measured, rowsBefore: 20, rowsAfter: 20 }), null);
  assert.equal(raiseContentFloor(null, { measured, rowsBefore: 20, rowsAfter: 12 }), null);
  assert.ok(raiseContentFloor(null, { measured, rowsBefore: 20, rowsAfter: 21 }));
});

test('an unmeasurable layer raises nothing', () => {
  assert.equal(raiseContentFloor(null, { measured: 0, rowsBefore: 0, rowsAfter: 30 }), null);
});

test('a live floor is never extended, whatever the timeline does', () => {
  const first = raiseContentFloor(null, { measured: 1938, rowsBefore: 10, rowsAfter: 18 });
  const again = raiseContentFloor(first, { measured: 9999, rowsBefore: 18, rowsAfter: 40 });
  assert.equal(again, first);
});

test('a floor expires after FLOOR_FRAMES frames', () => {
  let floor: ContentFloor = raiseContentFloor(null, { measured: 1938, rowsBefore: 1, rowsAfter: 2 });
  for (let frame = 0; frame < FLOOR_FRAMES - 1; frame += 1) {
    floor = ageContentFloor(floor);
    assert.ok(floor, `floor should still be up after ${frame + 1} frame(s)`);
  }
  assert.equal(ageContentFloor(floor), null);
  assert.equal(ageContentFloor(null), null);
});
