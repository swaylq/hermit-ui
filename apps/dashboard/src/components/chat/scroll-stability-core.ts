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
