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

/** Corrections below this are invisible, and only risk fighting the browser's own rounding. */
export const EPSILON = 0.5;

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
  return { correction: Math.abs(raw) < eps ? 0 : raw, offset };
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
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  epsilon?: number;
};

export type BottomFramePlan = {
  correction: number;
  gap: number;
};

export function planBottomFrame(hold: BottomHold, input: BottomFrameInput): BottomFramePlan {
  const eps = input.epsilon ?? EPSILON;
  const userDelta = input.scrollTop - hold.lastTop;
  const gap = hold.gap - userDelta;
  const raw = input.scrollHeight - input.scrollTop - input.clientHeight - gap;
  return { correction: Math.abs(raw) < eps ? 0 : raw, gap };
}
