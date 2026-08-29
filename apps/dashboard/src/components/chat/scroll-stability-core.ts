/**
 * Arithmetic for keeping a reading position stable without touching scrollTop
 * while a native scroll (including WebKit momentum) is in flight.
 *
 * `deviation` uses the same sign as the scrollTop correction it replaces. The
 * content layer is translated by `-deviation`, so the natural coordinate at the
 * top of the viewport is always `scrollTop + deviation`.
 */

export type CompensationSettlement = {
  wantedTop: number;
  nextTop: number;
  applied: number;
  deviation: number;
};

export type SubpixelCompensation = {
  deviation: number;
  compensated: number;
};

export type BoundaryRebaseInput = {
  /** Physical scroll offset owned by the browser. */
  scrollTop: number;
  /** Correction currently held in the content transform. */
  deviation: number;
  minTop: number;
  maxTop: number;
  /**
   * Signed movement the reader is still asking for, in scrollTop coordinates:
   * negative heads toward the top, positive heads toward the bottom.
   */
  readerDelta: number;
  /** Physical-boundary and meaningful-deviation tolerance. */
  epsilon?: number;
};

export function logicalScrollTop(scrollTop: number, deviation: number): number {
  return scrollTop + deviation;
}

/**
 * The scroller's content height, measured where a transform cannot reach it.
 *
 * Two engine facts, both measured in WebKit on the live dashboard:
 *
 *   · a DOWNWARD translate on the content layer extends the scroller's
 *     scrollable overflow by its own size — a 3750px scroller reports 4250
 *     under `translateY(500px)`;
 *   · WebKit only recomputes that overflow when the transform is ADDED or
 *     REMOVED. Changing the value leaves `scrollHeight` latched at whatever the
 *     last add produced: 3750 → (−500) 4250 → (−300) 4250 → (−700) 4250 →
 *     (+200) 4250 → (0) 3750. Chromium recomputes on every change; WebKit does
 *     not, and no forced layout or extra frame shakes it loose.
 *
 * So `scrollHeight` cannot be corrected arithmetically — after the first
 * correction of a hold there is no reliable relationship between it and the
 * content. The layer's own `offsetHeight` is layout, not paint, so a transform
 * never touches it: 3750 in every one of those states. Measure there.
 *
 * Everything that asks "how far from the end am I" must use this. The tail
 * anchor asked `scrollHeight`, so its own correction became the next frame's
 * input, and the tail flew ±1,500px for six frames on a plain open.
 */
export function contentHeight(input: {
  /** `offsetHeight` of the transformed content layer, 0 when it is not there. */
  layerHeight: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  const natural = input.layerHeight > 0 ? input.layerHeight : input.scrollHeight;
  return Math.max(input.clientHeight, natural);
}

/**
 * How much of a would-be correction the visible coordinate can actually take.
 *
 * Before corrections moved into the transform, this limit was the browser's:
 * the correction was a `scrollTop` write, a write past either end was clamped,
 * and the caller adopted the shortfall (see `settledHold` in
 * prepend-anchor-core.ts). That made the loop self-limiting. A transform has no
 * end stops, so a correction computed from a transient bad measurement is
 * painted in full — and, through the inflation above, feeds the next one.
 *
 * `scrollTop + deviation` is the content coordinate at the top of the viewport.
 * Outside `[minTop, maxTop]` it means showing blank space above the first
 * message or below the last, which is never what any caller wanted.
 */
export function acceptableCompensation(input: {
  scrollTop: number;
  deviation: number;
  delta: number;
  minTop: number;
  maxTop: number;
}): number {
  const current = input.scrollTop + input.deviation;
  const hi = Math.max(input.minTop, input.maxTop);
  const next = Math.max(input.minTop, Math.min(hi, current + input.delta));
  const accepted = next - current;
  // A `scrollTop` write moved AT MOST `delta`, and never against it. Starting
  // already outside the range (a fling to a physical end while a correction is
  // held) must therefore refuse the correction, not snap back into range: the
  // caller books `raw - applied` as "the user scrolled", so a correction that
  // came back with the opposite sign would corrupt the hold as well as jump.
  return input.delta > 0
    ? Math.max(0, Math.min(input.delta, accepted))
    : Math.min(0, Math.max(input.delta, accepted));
}

/**
 * Coordinate used by an anchor to identify real reader input. App corrections
 * increase both the logical position and `compensated`, so they cancel here;
 * native input changes only scrollTop and remains visible.
 */
export function readerScrollTop(scrollTop: number, deviation: number, compensated: number): number {
  return scrollTop + deviation - compensated;
}

/**
 * Reader coordinates contain no app-owned movement, so every negative change is
 * real upward input. Do not apply a per-event deadband: WebKit can split one slow
 * drag into arbitrarily many sub-2px scroll events.
 */
export function readerMovedUp(previous: number, current: number): boolean {
  return current < previous;
}

/** Pinch zoom and horizontal trackpad swipes are not timeline wheel input. */
export function isVerticalWheelInput(deltaX: number, deltaY: number, ctrlKey: boolean): boolean {
  return !ctrlKey && deltaY !== 0 && Math.abs(deltaY) >= Math.abs(deltaX);
}

/**
 * Drop a correction too small to justify a scrollTop write without changing the
 * reader-only coordinate. The discarded transform never became a lasting app
 * correction, so it must also be removed from the cumulative compensation.
 */
export function discardSubpixelDeviation(
  deviation: number,
  compensated: number,
  epsilon: number,
): SubpixelCompensation {
  if (Math.abs(deviation) >= epsilon) return { deviation, compensated };
  return { deviation: 0, compensated: compensated - deviation };
}

/**
 * Settle as much deviation as the scroller can currently accept.
 *
 * The invariant is `scrollTop + deviation`: even when a boundary clamps the
 * write, the remainder stays in the transform and the visible content does not
 * move.
 */
export function settleCompensation(
  scrollTop: number,
  deviation: number,
  minTop: number,
  maxTop: number,
): CompensationSettlement {
  const wantedTop = scrollTop + deviation;
  const nextTop = Math.max(minTop, Math.min(maxTop, wantedTop));
  const applied = nextTop - scrollTop;
  return { wantedTop, nextTop, applied, deviation: deviation - applied };
}

/**
 * Plan the one settlement that restores native scroll runway at a boundary.
 *
 * A positive transform deviation makes the logical position farther down than
 * physical `scrollTop`. If native upward input reaches physical zero first, the
 * browser cannot expose the older logical content: more input is clamped even
 * though `scrollTop + deviation` is still positive. The bottom/negative case is
 * symmetric.
 *
 * Rebase only once the reader is actively asking to cross the blocked boundary.
 * Away from that boundary the remaining physical runway is valuable native
 * motion, so the controller must keep holding the transform and return `null`.
 */
export function planBoundaryRebase(input: BoundaryRebaseInput): CompensationSettlement | null {
  const epsilon = Math.max(0, input.epsilon ?? 1);
  const meaningfulDeviation = Math.abs(input.deviation) >= epsilon && input.deviation !== 0;
  if (!meaningfulDeviation || input.readerDelta === 0) return null;

  const blockedAtTop = input.readerDelta < 0
    && input.deviation > 0
    && input.scrollTop <= input.minTop + epsilon;
  const blockedAtBottom = input.readerDelta > 0
    && input.deviation < 0
    && input.scrollTop >= input.maxTop - epsilon;
  if (!blockedAtTop && !blockedAtBottom) return null;

  const plan = settleCompensation(
    input.scrollTop,
    input.deviation,
    input.minTop,
    input.maxTop,
  );
  // A temporarily collapsed scroll range may have nowhere to put the transform.
  // Do not recommend a no-op setter; a later resize can ask again.
  return plan.applied === 0 ? null : plan;
}

/**
 * How much of a held deviation has to be given back because the reader has
 * scrolled to where it can no longer exist.
 *
 * A negative deviation is painted as content pushed DOWN, which makes the
 * physical scroller taller than the conversation really is: the reader can then
 * scroll up through `|deviation|` px of space that is not there. Nothing stops
 * them, because `scrollTop` has runway even after `scrollTop + deviation` has
 * gone above the top of the content.
 *
 * `planBoundaryRebase` does not cover this. Its two cases are a POSITIVE
 * deviation at the top and a NEGATIVE one at the bottom — both situations where
 * `scrollTop` still has somewhere to go, so one setter call fixes them. A
 * negative deviation at the top has nowhere to go: `settleCompensation` would
 * return `applied: 0`, which `planBoundaryRebase` correctly refuses to
 * recommend. So it survives the whole gesture and `commitDeviation` discards it
 * in a single frame when scrolling stops — measured at 245px and 348px on a
 * conversation whose history loads when the reader reaches the top.
 *
 * Give it back a frame at a time instead, as the reader scrolls into it. The
 * arithmetic is the same amount either way; the difference is that it is spread
 * across the gesture rather than delivered in one frame after it. What the
 * reader feels is a scroller that stops responding at the top, which is what
 * every scroller does at the top.
 *
 * Returns the signed amount to ADD to the deviation, `0` when it is honest.
 */
export function trimOutOfRangeDeviation(input: {
  scrollTop: number;
  deviation: number;
  minTop: number;
}): number {
  const logical = input.scrollTop + input.deviation;
  const excess = input.minTop - logical;
  // Only an overshoot ABOVE the top, and only ever toward zero: a deviation
  // whose sign does not put the reader out of range is doing its job.
  if (excess <= 0 || input.deviation >= 0) return 0;
  return Math.min(excess, -input.deviation);
}

/**
 * Is a scroller with this computed `overflow-anchor` safe for the attribution
 * rule everything here rests on?
 *
 * That rule — "whatever moved `scrollTop` since our last write was the user,
 * because we are the only other writer" (prepend-anchor-core.ts) — is not a
 * property of this code. It is a property of ONE CSS declaration,
 * `[overflow-anchor:none]`, sitting on the layer in chat/page.tsx. With browser
 * scroll anchoring on, the engine becomes a second writer of `scrollTop`, and
 * `planFrame`, `planTailFrame` and `forcedByClamp` all silently start
 * attributing the engine's adjustments to the reader.
 *
 * The comment in prepend-anchor-core used to credit base-ui for setting it. It
 * does not — grep the installed package, there are no hits — so the declaration
 * could have been deleted as an unexplained utility class with nothing failing
 * loudly. Hence a check.
 *
 * `undefined` / `''` means the browser does not implement the property, and a
 * browser that does not implement it does not do scroll anchoring either, so
 * the invariant holds for free. WebKit only shipped it in 2026-02.
 */
export function scrollerIsUnanchored(computedOverflowAnchor: string | undefined | null): boolean {
  if (!computedOverflowAnchor) return true;
  return computedOverflowAnchor.trim().toLowerCase() === 'none';
}
