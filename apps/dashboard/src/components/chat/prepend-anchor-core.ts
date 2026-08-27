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
  /** Tallest the conversation has measured during this hold — see classifyTailFrame. */
  peak: number;
};

/**
 * What a frame's geometry is worth to a tail hold.
 *
 * History is being prepended, so the conversation only grows. A frame that
 * measures far shorter than the tallest this hold has seen is therefore not a
 * measurement of it — it is a glimpse of it mid-render. The anchor's own log,
 * on a plain open of a live session, alternated
 * 652, 1484, 665, 1619, 778, 1690 across consecutive corrections, and the
 * short readings pulled the reader back by 819 and 841px before the tall ones
 * put them forward again. Every one of those was painted.
 *
 *   · 'measure'  — ordinary geometry, plan and correct from it.
 *   · 'absorb'   — the whole list is inside one viewport, so the browser has
 *                  ALSO clamped scrollTop to 0. Plan, so `settledHold` cancels
 *                  that clamp against the correction it would imply, but paint
 *                  nothing: the correction is a full-viewport yank the next
 *                  frame takes straight back.
 *   · 'ignore'   — a partial render with the scroll position untouched. Do not
 *                  correct and do not book: `settledHold` would fold this
 *                  frame's nonsense into the gap and hold it forever.
 */
export type TailFrameKind = 'measure' | 'absorb' | 'ignore';

export function classifyTailFrame(input: {
  contentHeight: number;
  clientHeight: number;
  peak: number;
}): TailFrameKind {
  if (input.contentHeight <= input.clientHeight) return 'absorb';
  if (input.contentHeight < input.peak - input.clientHeight) return 'ignore';
  return 'measure';
}

export type BottomFrameInput = {
  /** Natural/visual scroll coordinate (`physical scrollTop + deviation`). */
  scrollTop: number;
  /** Coordinate with app compensation removed; defaults to scrollTop. */
  userScrollTop?: number;
  scrollHeight: number;
  clientHeight: number;
  epsilon?: number;
};

/**
 * Has a tail hold stopped describing a reader who is at the tail?
 *
 * `capture()` only takes a tail hold when the reader is within `slack` of the
 * end. So a hold whose target has drifted FURTHER than that slack is no longer
 * describing the same reader, whatever moved it, and the honest thing is to
 * abandon it rather than keep holding a position nobody chose.
 *
 * Two very different things land here, and the point is that neither needs to
 * be recognised:
 *
 *   · The reader really left — PageUp, a scrollbar drag, a wheel, a fling.
 *     Abandoning is right: they get to read history, and because
 *     `onAnchorRelease` only chases the tail while the pin is still on (and
 *     their own scrolling has already dropped it), nothing pulls them back.
 *
 *   · Nobody left, and `scrollTop` moved anyway — the virtualised window
 *     re-rendered the rows above the viewport, or the browser clamped a list
 *     that momentarily shrank. Measured on a real 420-row session (round 0):
 *     `scrollTop` fell 209px between `capture()` and the first corrected frame.
 *     The old code adopted that as the reader's own scrolling, so the hold's
 *     TARGET became 209px above the end and every later frame faithfully held
 *     them there — visible for 1.5s until sticky bottom noticed and yanked them
 *     down. Abandoning is right here too: the pin is still on, so the release
 *     hands the tail straight back to sticky bottom, which puts them at the end
 *     — where the tail hold was trying to keep them in the first place.
 *
 * Round 1 tried to separate the two by asking `hasUpwardReaderIntent()` whether
 * to believe the movement at all. That was worse than the bug: the predicate
 * only rises for wheel and touch, so keyboard paging and dragging the scrollbar
 * (a SIBLING of the viewport — its pointer events never reach the viewport's
 * listeners) were disbelieved and silently undone. Three PageUps moved
 * `scrollTop` 1,690px and the screen did not move at all. Distance needs no
 * such taxonomy of inputs, and cannot be defeated by an input nobody thought of.
 */
export function tailHoldLost(gap: number, slack: number): boolean {
  return gap > slack;
}

/**
 * How much of this frame's movement did the BROWSER force?
 *
 * The scroller sets `overflow-anchor: none`, so growth above the viewport never
 * shifts it. The one non-reader way `scrollTop` moves is the opposite case: the
 * content gets SHORTER than the current offset and the browser has no choice but
 * to clamp to the new maximum. That is a continuous quantity — exactly how far
 * past the new end the old position was — and subtracting it leaves the reader's
 * own contribution, whatever else happened in the same frame.
 *
 * Round 3 asked this as a yes/no question instead ("did the new offset land ON
 * the maximum, to the pixel?"). Two things were wrong with it, both found by
 * review:
 *
 *   · A frame where the list shrank AND the reader scrolled fails the pixel
 *     test, so the WHOLE displacement — the browser's part included — was booked
 *     as the reader's. Measured with the real function: a 300px shrink plus a
 *     30px scroll came out as `gap: 330`, and the reader was thrown out of a
 *     hold they never left.
 *
 *   · Worse, it compared coordinates from two different systems. `lastTop` is a
 *     READER coordinate (the app's own compensation removed) while the maximum
 *     is a LOGICAL one; inside one hold those were measured 1,080px apart. Once
 *     a hold had applied its first correction, `prevTop > maxTop` could never be
 *     true again, so the detection was structurally dead for the rest of the
 *     hold — it only ever fired on the frame where the compensation was still 0.
 *
 * So: no pixel coincidence, no yes/no, and both sides converted to the same
 * coordinates before they are compared.
 */
export function forcedByClamp(input: {
  /** `scrollTop` after our last correction, in READER coordinates. */
  lastTop: number;
  /** The largest `scrollTop` the content allows, in READER coordinates. */
  maxTopReader: number;
}): number {
  return Math.min(0, input.maxTopReader - input.lastTop);
}

/**
 * Should this prepend hold the TAIL, or a row up in the conversation?
 *
 * Pure so it can be tested, because the wiring is where two regressions have now
 * hidden. Round-4 review: reverting all three of the hook's decisions left
 * 731/731 tests green, since every test addressed the frame arithmetic and none
 * addressed which hold gets taken in the first place.
 *
 * Two ways in. The geometry says we are at the end — that is the ordinary case.
 * Or the page says the reader is still following the tail AND the geometry is at
 * least plausible: on a cold cache the measurement is taken while the list is
 * still assembling, and a row hold born from that noise strands the reader for
 * good (measured cold, 4 opens in 6 settled 270px short and STAYED, pin still
 * on, so not even a "↓ latest" appeared).
 *
 * The one-viewport bound on that second door is not decoration. `pinnedRef` can
 * be stale-true, and forcing a tail hold from thousands of pixels up would yank
 * someone reading history down to the bottom — the same mistake pointing the
 * other way, and a worse one.
 */
export function chooseTailHold(input: {
  contentBottomGap: number;
  clientHeight: number;
  followingTail: boolean;
  slack: number;
}): boolean {
  if (input.contentBottomGap < input.slack) return true;
  return input.followingTail && input.contentBottomGap < input.clientHeight;
}

export type TailFrameInput = {
  /** `scrollTop` in reader coordinates — the app's own compensation removed. */
  readerTop: number;
  /** Natural/visual scroll coordinate, for the geometry sums. */
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The largest `scrollTop` the content currently allows. */
  maxTop: number;
  /** How far from the tail still counts as being at it. */
  slack: number;
  epsilon?: number;
};

export type TailFramePlan = BottomFramePlan & {
  /** The hold has stopped describing a reader at the tail — let go of it. */
  abandon: boolean;
  /** Whether this frame's movement was the browser clamping rather than a person. */
  clamped: boolean;
};

/**
 * One tail-hold frame, end to end, as a pure function.
 *
 * Deliberately whole rather than three helpers the hook stitches together: when
 * the decision lived in the hook, both of the wrong rules above passed a full
 * green test suite. Reverting either one changed no test, because every test
 * addressed a helper and none addressed the decision. This is the decision.
 */
export function planTailFrame(hold: BottomHold, input: TailFrameInput): TailFramePlan {
  // Both sides into READER coordinates before anything is compared. The
  // compensation currently painted as a transform is the difference between the
  // two systems, and it is available right here as logical minus reader.
  const compensated = input.scrollTop - input.readerTop;
  const forced = forcedByClamp({ lastTop: hold.lastTop, maxTopReader: input.maxTop - compensated });
  // Whatever moved beyond what the browser had to do is the reader.
  const userDelta = input.readerTop - hold.lastTop - forced;
  const gap = hold.gap - userDelta;
  const eps = input.epsilon ?? EPSILON;
  const raw = input.scrollHeight - input.scrollTop - input.clientHeight - gap;
  return {
    correction: Math.abs(raw) < eps ? 0 : raw,
    gap,
    raw,
    clamped: forced < 0,
    abandon: tailHoldLost(gap, input.slack),
  };
}

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
