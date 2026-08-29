// Which slice of a long timeline is worth having in the DOM.
//
// A long conversation is one very tall scroller — 2,000 rows is ~100,000px —
// and WebKit (Safari, so the phone and the home-screen PWA) pays for all of it
// on every frame. Measured on a 2,000-message session: p90 frame time 137ms,
// worst 210ms, 28 of 70 frames over budget, while Chrome held a flat 14ms with
// none. Hiding everything outside a few screens of the viewport, same page and
// same gesture, took that to p90 30ms and 1 janky frame in 52.
//
// CSS containment was tried first and measured worse, twice: `content-visibility:
// auto` with a 320px placeholder inflated the page 4× (36,000px → 136,000px) and
// left the jank untouched; a realistic 64px placeholder was still worse than the
// baseline; `contain: layout` did nothing. The rows have to actually leave.
//
// This is the arithmetic, kept away from the DOM so it can be tested: given each
// item's height, where does the window start and end, and how tall are the
// spacers that stand in for what is not rendered.

export type WindowPlan = {
  /** First item index to render. */
  start: number;
  /** One past the last item index to render. */
  end: number;
  /** Height of the spacer standing in for items before `start`. */
  padTop: number;
  /** Height of the spacer standing in for items from `end` on. */
  padBottom: number;
};

/** The timeline container's 0.75rem gap at the dashboard's 16px root size. */
export const TIMELINE_ROW_GAP = 12;

/**
 * A spacer already represents row extents that include their trailing gap. The
 * flex container adds the boundary gap itself, so the spacer box gives one back.
 */
export function spacerBoxHeight(extent: number): number {
  return Math.max(0, extent - TIMELINE_ROW_GAP);
}

export type WindowInput = {
  /** Each item's height INCLUDING the gap below it — measured, or estimated. */
  heights: number[];
  scrollTop: number;
  viewportHeight: number;
  /** Extra px to keep mounted above and below the viewport. */
  overscan: number;
  /**
   * Below this many items, render everything. Short conversations — which is
   * most of them — then behave exactly as they did before any of this existed,
   * and the jank only starts mattering well above the threshold anyway.
   */
  threshold: number;
};

export type WindowDecision = {
  rows: number;
  scrollHeight: number;
  clientHeight: number;
  rowLimit: number;
  screens: number;
  minRows: number;
};

/** A long list can be expensive by row count or by rendered weight. */
export function shouldWindow(d: WindowDecision): boolean {
  if (d.rows > d.rowLimit) return true;
  if (d.rows < d.minRows || d.clientHeight <= 0) return false;
  return d.scrollHeight > d.clientHeight * d.screens;
}

/**
 * Is a list worth windowing?
 *
 * Not "does it have many rows". `foldRuns` collapses a whole tool chain into one
 * capsule, so a row count says nothing about what the rows weigh: an agent that
 * mostly runs tools folds around thirteen messages into each row, and one real
 * 6,941-message session became 279 rows — under any sane row threshold — while
 * carrying 4,818 DOM nodes and sixty-four screens of content. Measured on that
 * session with windowing off: 189ms per frame, every frame over budget. On: 17ms.
 *
 * Content far taller than the viewport is the honest question, because it means
 * most of the list is off screen whatever the row count — which is the whole
 * premise of windowing. The row count stays as a second way in, for a very long
 * list of very short rows.
 */
/** Render everything: what a short timeline gets, and the safe fallback. */
export function fullWindow(count: number): WindowPlan {
  return { start: 0, end: count, padTop: 0, padBottom: 0 };
}

export function planWindow(input: WindowInput): WindowPlan {
  const { heights, scrollTop, viewportHeight, overscan, threshold } = input;
  const n = heights.length;
  if (n <= threshold) return fullWindow(n);

  const top = scrollTop - overscan;
  const bottom = scrollTop + viewportHeight + overscan;

  let start = 0;
  let padTop = 0;
  let y = 0;
  // The first item whose BOTTOM edge is still below the top boundary — i.e. the
  // first one with any pixel inside the kept band.
  while (start < n && y + heights[start] <= top) {
    y += heights[start];
    padTop = y;
    start++;
  }
  let end = start;
  // ...through the last item whose TOP edge is above the bottom boundary.
  while (end < n && y < bottom) {
    y += heights[end];
    end++;
  }
  let padBottom = 0;
  for (let i = end; i < n; i++) padBottom += heights[i];

  // A scroll position past the end walks `start` off the list. That happens
  // whenever the list SHRINKS under a stale scrollTop — most often on open,
  // where the local cache paints every row it holds (hundreds) and the server's
  // 60-row window then replaces them.
  //
  // Anchor at the end and walk BACK until the kept band is covered.
  //
  // This used to return a single row (`start = n - 1`) and it is the reason the
  // shrink was VISIBLE. Replayed through this function with the reported
  // numbers — 600 cached rows at 90px, a 700px viewport, shrinking to 18 items
  // — one row left 90px of message in a 700px viewport and 87% spacer. Worse,
  // `use-timeline-window`'s remap branch carries the span of the previous plan
  // across every later signature change and only falls through to a full
  // recompute when the start row is MISSING, so a span of 1 was re-carried on
  // every streaming tick and never widened again: the reader sat in a blank
  // pane, with a scrollbar, for the rest of the turn.
  //
  // The band is `viewportHeight + overscan` rather than the usual
  // `+ 2 * overscan` because there is nothing below the end to overscan into.
  if (start >= n) {
    end = n;
    start = n;
    const band = viewportHeight + overscan;
    let covered = 0;
    while (start > 0 && covered < band) {
      start--;
      covered += heights[start];
    }
    padTop = 0;
    for (let i = 0; i < start; i++) padTop += heights[i];
    padBottom = 0;
  }
  return { start, end, padTop, padBottom };
}

/**
 * A plan that cannot point outside the list it is used with.
 *
 * The plan is React state, so between the row list changing length and the
 * layout effect that replans, a render happens where the plan still describes
 * the OLD list. Every consumer then indexes past the end. That is not
 * hypothetical: replacing `items.slice(start, end)` — which clamps out-of-range
 * indices silently, as every JS array method does — with a `for` loop over the
 * same numbers took the production dashboard down with "Cannot read properties
 * of undefined (reading 'kind')".
 *
 * So clamp where the plan is produced rather than at each place it is read. A
 * consumer that forgets is the normal case; there is no reason for a plan to be
 * able to name a row that does not exist.
 */
export function clampPlan(plan: WindowPlan, count: number): WindowPlan {
  const end = Math.min(plan.end, count);
  const start = Math.min(plan.start, end);
  if (start === plan.start && end === plan.end) return plan;
  // The spacers are deliberately left alone. They stand in for rows that are not
  // rendered, and the heights they were computed from are the ones the reading
  // position was corrected against; recomputing them here from a list this
  // function cannot see would move the reader to hide an inconsistency that the
  // replan is about to fix properly.
  return { ...plan, start, end };
}

/**
 * The rows a plan says to render. The only way `TimelineBody` should get at
 * them — it is where the out-of-range read happened, so it is worth having a
 * function that cannot do it and a test that says so.
 */
export function visibleSlice<T>(items: T[], plan: { start: number; end: number }): T[] {
  const p = clampPlan({ start: plan.start, end: plan.end, padTop: 0, padBottom: 0 }, items.length);
  return items.slice(p.start, p.end);
}

/** A row that changed height after it was already mounted. */
export type SettledRow = {
  /** Height before the change, including the gap below it. */
  was: number;
  /** Height after it. */
  now: number;
  /** The row's bottom edge AFTER the change, in the scroller's own coordinates. */
  bottom: number;
};

/**
 * How far the reading position was pushed by rows that settled above it.
 *
 * `padTop` only covers rows OUTSIDE the window; a row inside it is a real
 * element, so when it changes height `padTop` does not move and the correction
 * that watches `padTop` sees nothing to do. But the window keeps three screens
 * of rows mounted above the viewport, and every one of them can still change
 * height long after it mounted — an image decoding, a code block gaining a
 * horizontal scrollbar, markdown replacing its own source, a translation
 * replacing the original text. Each one shoves everything below it, including
 * what the reader is looking at, and nothing was undoing that.
 *
 * Only rows that were ENTIRELY above the reader count. A row straddling the top
 * edge is the one being read from partway down: part of its change is above the
 * reader's eye and part below, there is no single right answer, and guessing
 * moves text that did not need to move.
 */
export function liftFromSettled(rows: SettledRow[], viewportTop: number): number {
  let lift = 0;
  let cumulativeChange = 0;
  // ResizeObserver reports post-layout boxes. A row's post-layout bottom already
  // includes every changed sibling before it, so reconstruct each pre-layout
  // edge with the cumulative delta in DOM order rather than subtracting only
  // that row's own change.
  const ordered = [...rows].sort((a, b) => a.bottom - b.bottom);
  for (const r of ordered) {
    const grew = r.now - r.was;
    cumulativeChange += grew;
    if (grew === 0) continue;
    // Where the bottom edge was BEFORE the change. A row that was fully above
    // the reader pushed them by `grew` whether or not the push then carried its
    // own bottom edge down past the top of the viewport — testing the post-change
    // edge would drop exactly the biggest pushes.
    if (r.bottom - cumulativeChange > viewportTop) continue;
    lift += grew;
  }
  return lift;
}

/**
 * A height to use for items that have never been on screen. The running mean of
 * what HAS been measured beats any constant: these rows are anything from a
 * one-line "ok" to a page of markdown, and the mean tracks whichever this
 * conversation is made of.
 */
export function estimateFrom(measured: Map<string, number>, fallback: number): number {
  if (measured.size === 0) return fallback;
  let sum = 0;
  for (const h of measured.values()) sum += h;
  return sum / measured.size;
}

/**
 * What a row's measured height turned out to be, per px of prose in it.
 *
 * `a` is the slope and `b` the fixed part: bubble padding, the avatar row, the
 * timestamp, the gaps between markdown blocks — everything that is there
 * whatever the text says. The slope picks up the rest, including the fact that
 * the prose was laid out at the ROW's width rather than at the bubble's (85% of
 * it, less padding), which is a systematic scale error and exactly what a slope
 * is for. Nothing here is hand-written, so a CSS change re-fits rather than
 * quietly rotting.
 */
export type ProseFit = { a: number; b: number; samples: number };

/** Below this many measured rows the fit is noise; keep using the mean. */
const MIN_FIT_SAMPLES = 8;
/** A slope outside this says the inputs are not what we think they are. */
const MIN_SLOPE = 0.4;
const MAX_SLOPE = 4;
/** No row is shorter than one line plus its gap, whatever the arithmetic says. */
const MIN_ROW = 24;

function leastSquares(pairs: Array<{ prose: number; real: number }>): { a: number; b: number } | null {
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pairs) {
    sx += p.prose;
    sy += p.real;
    sxx += p.prose * p.prose;
    sxy += p.prose * p.real;
  }
  const denom = n * sxx - sx * sx;
  // Every sample the same length: a slope through one point is not a slope.
  if (Math.abs(denom) < 1e-6) return null;
  return { a: (n * sxy - sx * sy) / denom, b: (sy - ((n * sxy - sx * sy) / denom) * sx) / n };
}

/**
 * Fit measured heights against predicted prose heights.
 *
 * Refit once with the outliers dropped, because a fair number of rows are prose
 * PLUS something this cannot predict — a screenshot, a fenced code block, an
 * expandable run capsule — and plain least squares would let a handful of those
 * tilt the line for everyone else. Two passes is enough: the second fit
 * describes the ordinary row, and the extraordinary ones keep being wrong, which
 * is honest, because nothing here can see what makes them tall.
 */
export function fitProseHeights(pairs: Array<{ prose: number; real: number }>): ProseFit | null {
  const usable = pairs.filter((p) => p.prose > 0 && p.real > 0);
  if (usable.length < MIN_FIT_SAMPLES) return null;
  const first = leastSquares(usable);
  if (!first) return null;
  let sum = 0;
  for (const p of usable) sum += Math.abs(p.real - (first.a * p.prose + first.b));
  const mean = sum / usable.length;
  const kept = mean > 0 ? usable.filter((p) => Math.abs(p.real - (first.a * p.prose + first.b)) <= 2 * mean) : usable;
  const fit = (kept.length >= MIN_FIT_SAMPLES ? leastSquares(kept) : first) ?? first;
  if (!(fit.a >= MIN_SLOPE && fit.a <= MAX_SLOPE) || !Number.isFinite(fit.b)) return null;
  return { a: fit.a, b: fit.b, samples: kept.length };
}

/**
 * Per-item heights: what was measured, an estimate for everything else.
 *
 * Keyed by the item's own key, never by its index. "Load earlier" prepends a
 * page, which shifts every index down by 40 — index-keyed heights would then
 * describe the wrong messages, and the correction that holds the reading
 * position would shove the view by the size of the mistake.
 *
 * Three tiers, best first: a real measurement; a prediction from the row's own
 * prose once enough rows have been measured to fit against; and the running mean
 * for everything else — a row with no prose at all (a picture, a run capsule),
 * or any row before the fit has anything to stand on.
 */
export function heightsFor(
  keys: string[],
  measured: Map<string, number>,
  fallback: number,
  prose?: Map<string, number>,
  fit?: ProseFit | null,
): number[] {
  const est = estimateFrom(measured, fallback);
  return keys.map((k) => {
    const m = measured.get(k);
    if (m !== undefined) return m;
    if (!fit || !prose) return est;
    const p = prose.get(k);
    if (p === undefined || p <= 0) return est;
    return Math.max(MIN_ROW, fit.a * p + fit.b);
  });
}
