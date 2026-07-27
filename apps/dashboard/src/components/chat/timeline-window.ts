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

  // Never hand back an empty window: a scroll position past the end (which
  // happens for a moment while the list shrinks) would otherwise render nothing
  // at all, and the user would see a blank pane rather than the last messages.
  if (start >= n) {
    start = Math.max(0, n - 1);
    padTop = 0;
    for (let i = 0; i < start; i++) padTop += heights[i];
    end = n;
    padBottom = 0;
  }
  return { start, end, padTop, padBottom };
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
 * Per-item heights: what was measured, an estimate for everything else.
 *
 * Keyed by the item's own key, never by its index. "Load earlier" prepends a
 * page, which shifts every index down by 40 — index-keyed heights would then
 * describe the wrong messages, and the correction that holds the reading
 * position would shove the view by the size of the mistake.
 */
export function heightsFor(keys: string[], measured: Map<string, number>, fallback: number): number[] {
  const est = estimateFrom(measured, fallback);
  return keys.map((k) => measured.get(k) ?? est);
}
