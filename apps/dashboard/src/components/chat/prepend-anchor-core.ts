// The arithmetic behind the prepend anchor, kept out of the DOM so the one rule
// that matters is testable: the anchor absorbs layout growth above the reading
// position, and NEVER opposes the user's own scrolling.
//
// Getting that wrong is not a subtle bug. The first version corrected by the
// anchor row's total displacement, which is growth and user input added
// together, so every wheel notch was undone on the next frame. Measured on the
// live dashboard: after a "load earlier", 4800px of wheel input moved the view
// 59px — 60fps the whole time, and the conversation simply would not move.
//
// The two are separable because they leave different fingerprints:
//
//   · the user (wheel, trackpad, scrollbar, arrow keys, touch) changes
//     `scrollTop` and nothing else,
//   · content growing above the anchor moves the anchor row down the viewport
//     and leaves `scrollTop` alone.
//
// So: whatever moved `scrollTop` since our last write was the user, because we
// are the only other writer — this scroller has `overflow-anchor: none` (base-ui
// sets it on the viewport's content box), so the browser never silently adjusts
// `scrollTop` on our behalf. Adopt that movement into the anchor and correct
// only what remains.

/**
 * Corrections below this are not worth issuing.
 *
 * Not merely "invisible": a write to `scrollTop` is the thing that ENDS a
 * momentum scroll on iOS (scrolling there is run by UIScrollView outside the
 * engine, and assigning an offset is `setContentOffset`, which cancels the
 * deceleration). So a sub-pixel correction does not cost a sub-pixel of
 * accuracy — it costs the reader their entire fling. And it cannot even land:
 * `scrollTop` is quantised, so anything under a pixel reads back unchanged.
 *
 * One CSS pixel. Below that, carry the difference instead (see `settledHold`).
 */
export const EPSILON = 1;

export type AnchorHold = {
  /** Where the anchor row is held, in px from the top of the viewport. */
  offset: number;
  /** `scrollTop` as it stood after our last correction. Anything else moved it: the user. */
  lastTop: number;
};

export type FrameInput = {
  /** The viewport's `scrollTop` right now, before this frame's correction. */
  scrollTop: number;
  /** The anchor row's top edge right now, in px from the top of the viewport. */
  anchorTop: number;
  epsilon?: number;
};

export type FramePlan = {
  /** px to add to `scrollTop` this frame. 0 means leave the viewport alone. */
  correction: number;
  /** The offset to carry forward — it tracks the user, so it changes as they scroll. */
  offset: number;
  /** The correction BEFORE the epsilon cut — what `settledHold` reconciles against. */
  raw: number;
};

export function planFrame(hold: AnchorHold, input: FrameInput): FramePlan {
  const eps = input.epsilon ?? EPSILON;
  // Everything the user did since we last looked. Adopting it means the anchor
  // rides along with them instead of dragging them back to where they were when
  // the page was requested.
  const userDelta = input.scrollTop - hold.lastTop;
  const offset = hold.offset - userDelta;
  // What's left is the anchor row having genuinely moved through the layout:
  // history prepended above it, markdown reflowing, an image resolving its
  // height. That, and only that, is worth correcting.
  const raw = input.anchorTop - offset;
  return { correction: Math.abs(raw) < eps ? 0 : raw, offset, raw };
}

/**
 * Where the hold sits once a correction has been ATTEMPTED — the difference
 * between what we asked the viewport to do and what it did.
 *
 * This is not bookkeeping pedantry; without it the pump writes `scrollTop` on
 * every frame of the settle window and never gets anywhere. Two ways a write
 * comes up short:
 *
 *   · `scrollTop` is quantised, so a 0.6px correction reads back unchanged;
 *   · the viewport is clamped at 0 or at the end, so the correction has nowhere
 *     to go.
 *
 * In both cases the next frame recomputes the SAME correction, writes again,
 * and so on — measured on the deployed dashboard at 93 writes in a 1.7s hold,
 * one per frame. Each of those ends the reader's momentum scroll on a phone,
 * which is what turns "load earlier" into a list that will not glide.
 *
 * So: adopt whatever actually happened. `held` is the offset (or, for the tail
 * hold, the gap) we were carrying, `raw` is what this frame asked for, and
 * `applied` is how far `scrollTop` really moved. What is left over stops being
 * a correction and becomes the new resting place.
 */
export function settledHold(held: number, raw: number, applied: number): number {
  return held + raw - applied;
}

/**
 * The bottom half of the same idea: hold the TAIL steady instead of a row.
 *
 * When the reader is pinned to the bottom (the top-up prefill that thickens a
 * short conversation, or a pull that fires while they're at the end), the thing
 * they're looking at is not a message near the top — it's the last row. Prepend
 * history there must keep that tail in view, so the new history appears ABOVE,
 * out of sight, rather than yanking the view to the top of what just arrived.
 *
 * The arithmetic mirrors `planFrame` exactly, with `scrollHeight` playing the
 * role the anchor row's position played above:
 *   · the user changes `scrollTop`, so that movement is adopted into the gap;
 *   · content growing changes `scrollHeight` (and thus the gap), so that is
 *     corrected by scrolling down the same amount.
 */

/** The distance between the bottom edge and the viewport bottom we're holding. */
export type BottomHold = {
  /** Distance from the content bottom to the viewport bottom, in px. */
  gap: number;
  /** `scrollTop` as it stood after our last correction. */
  lastTop: number;
};

export type BottomFrameInput = {
  /** Natural/visual scroll coordinate (`physical scrollTop + deviation`). */
  scrollTop: number;
  /** Coordinate with app compensation removed; defaults to scrollTop. */
  userScrollTop?: number;
  scrollHeight: number;
  clientHeight: number;
  epsilon?: number;
};

export type BottomFramePlan = {
  correction: number;
  gap: number;
  /** The correction BEFORE the epsilon cut — what `settledHold` reconciles against. */
  raw: number;
};

export function planBottomFrame(hold: BottomHold, input: BottomFrameInput): BottomFramePlan {
  const eps = input.epsilon ?? EPSILON;
  const userDelta = (input.userScrollTop ?? input.scrollTop) - hold.lastTop;
  const gap = hold.gap - userDelta;
  const raw = input.scrollHeight - input.scrollTop - input.clientHeight - gap;
  return { correction: Math.abs(raw) < eps ? 0 : raw, gap, raw };
}

/**
 * Should a new pull re-measure the reading position, or keep the hold it already
 * has?
 *
 * Keep it, while it is live. A hold describes where the reader was BEFORE the
 * history now landing; re-measuring in the middle of that records the
 * displacement as the target and makes it permanent — the reader never gets
 * those pixels back.
 *
 * This is not a rare interleaving. A page already in the local cache is
 * prepended with no network call at all, so on a warm cache a pull resolves
 * inside the same frame the scroll event fired in; the top-up prefill can fire
 * five of them back to back; and each one used to call capture() again. Measured
 * on a 509-message session, reopened warm and nudged up once: content grew
 * 2,481px, `scrollTop` moved 1,972px, and the reader lost the missing 509px in a
 * single frame. With the timing spread out by a network round trip instead, the
 * very same code compensated 2,531px to the pixel — which is why this only ever
 * showed up as "sometimes it jumps enormously".
 *
 * Keeping the hold is safe for both modes because both adopt whatever the user
 * did in the meantime: `planFrame` folds their scrolling into the offset and
 * `planBottomFrame` folds it into the tail gap. So a hold taken three pulls ago
 * still describes where they are now.
 */
export function shouldRecapture(held: { until: number } | null | undefined, now: number): boolean {
  return !held || now >= held.until;
}
