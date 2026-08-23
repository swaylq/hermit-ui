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
