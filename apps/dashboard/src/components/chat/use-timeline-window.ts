'use client';

// Keeps only the part of a long timeline that is near the viewport in the DOM,
// with spacers standing in for the rest. See timeline-window.ts for why, and for
// the arithmetic.
//
// Two things make this safe to bolt onto a list that is also being scrolled,
// anchored, and prepended to:
//
//   · Below the threshold nothing happens at all — same DOM, same behaviour, no
//     measuring. Most conversations never reach it.
//   · The reading position is held across every window change. A row that has
//     never been on screen is a guess until it is rendered, so replacing that
//     guess with a measurement changes the height ABOVE the viewport, which
//     would shove the text under the reader's eyes. Whenever that height moves,
//     `scrollTop` moves with it, in a layout effect, before the browser paints.
//
// That correction composes with the prepend anchor rather than fighting it: the
// anchor re-measures the real element position every frame and adopts any scroll
// change it did not make itself (see prepend-anchor-core.ts), so a correction
// applied here reads to it as already settled and produces no delta of its own.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { planWindow, fullWindow, heightsFor, type WindowPlan } from './timeline-window';

/** Below this many rows, render the whole thing and touch nothing. */
const THRESHOLD = 400;
/** Screens of extra rows kept mounted above and below the viewport. */
const OVERSCAN_SCREENS = 3;
/** Height assumed for a row nothing has been measured for yet. */
const FALLBACK_ROW = 90;
/** `space-y-3` between rows — part of the height an item occupies. */
const ROW_GAP = 12;

/** Marks a rendered item so the measurer can find it and know which row it is. */
export const WINDOW_ROW_ATTR = 'data-window-key';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export type TimelineWindow = WindowPlan & {
  /** True while the list is actually being windowed. */
  active: boolean;
};

/** Identifies WHICH list a plan was computed for — see the correction below. */
function signature(keys: string[]): string {
  return `${keys.length}:${keys[0] ?? ''}:${keys[keys.length - 1] ?? ''}`;
}

export function useTimelineWindow(keys: string[], getViewport: () => HTMLElement | null): TimelineWindow {
  const measured = useRef(new Map<string, number>());
  // `startKey` is what makes the window survive a prepend: see the remap below.
  const [plan, setPlan] = useState<WindowPlan & { sig: string; startKey: string | null }>(() => ({
    ...fullWindow(keys.length),
    sig: signature(keys),
    startKey: keys[0] ?? null,
  }));
  // Read by the scroll listener, which must not re-subscribe on every render.
  const keysRef = useRef(keys);
  useIsoLayoutEffect(() => {
    keysRef.current = keys;
  });

  const recompute = useCallback(() => {
    const vp = getViewport();
    const ks = keysRef.current;
    const sig = signature(ks);
    if (!vp || ks.length <= THRESHOLD) {
      setPlan((prev) =>
        prev.sig === sig && prev.start === 0 && prev.end === ks.length && prev.padTop === 0 && prev.padBottom === 0
          ? prev
          : { ...fullWindow(ks.length), sig, startKey: ks[0] ?? null }
      );
      return;
    }
    const next = planWindow({
      heights: heightsFor(ks, measured.current, FALLBACK_ROW),
      scrollTop: vp.scrollTop,
      viewportHeight: vp.clientHeight,
      overscan: vp.clientHeight * OVERSCAN_SCREENS,
      threshold: THRESHOLD,
    });
    setPlan((prev) =>
      prev.sig === sig && prev.start === next.start && prev.end === next.end && prev.padTop === next.padTop && prev.padBottom === next.padBottom
        ? prev
        : { ...next, sig, startKey: ks[next.start] ?? null }
    );
  }, [getViewport]);

  // Recompute on scroll and on resize. Cheap: a walk over an array of numbers,
  // never over the DOM.
  useEffect(() => {
    const vp = getViewport();
    if (!vp) return;
    const onScroll = () => recompute();
    vp.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(vp);
    return () => {
      vp.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [getViewport, recompute]);

  // The row list changed — a page prepended, a turn streamed, the mode toggled.
  //
  // A window described by INDEX does not survive that. "Load earlier" puts 40
  // items in front, so the same indices now name rows 40 further along, and the
  // row the reader was on falls out of the mounted range — taking the prepend
  // anchor's element with it, which is how the reading position gets lost
  // outright rather than merely nudged.
  //
  // So carry the window by the row it starts at. The heights above it grow by
  // exactly what was prepended, which is the same amount the anchor is adding to
  // `scrollTop`: together they leave the view where it was, exactly as real rows
  // above the viewport would have.
  const sig = signature(keys);
  useIsoLayoutEffect(() => {
    if (keys.length > THRESHOLD && plan.startKey && plan.sig !== sig) {
      const at = keys.indexOf(plan.startKey);
      if (at >= 0) {
        const span = Math.max(1, plan.end - plan.start);
        const heights = heightsFor(keys, measured.current, FALLBACK_ROW);
        const end = Math.min(keys.length, at + span);
        let padTop = 0;
        for (let i = 0; i < at; i++) padTop += heights[i];
        let padBottom = 0;
        for (let i = end; i < keys.length; i++) padBottom += heights[i];
        setPlan({ start: at, end, padTop, padBottom, sig, startKey: plan.startKey });
        return;
      }
    }
    recompute();
  }, [sig, recompute]);

  // Measure what is on screen, then hold the reading position if the space above
  // it turned out to be a different size than we had guessed.
  useIsoLayoutEffect(() => {
    const vp = getViewport();
    if (!vp || keys.length <= THRESHOLD) return;
    // Only correct against a plan computed for THIS list. "Load earlier"
    // prepends a page, which shifts every index: the height above index `start`
    // then describes a different stretch of conversation than the plan's
    // `padTop` did, and the difference between them is not a measurement error
    // to be corrected — it is the prepend itself, which the prepend anchor is
    // already holding. Correcting it too moved the view by ~2,400px in one frame.
    if (plan.sig !== sig) return;
    let changed = false;
    // The rows live inside the viewport we already have — no second ref needed.
    for (const node of Array.from(vp.querySelectorAll(`[${WINDOW_ROW_ATTR}]`))) {
      const key = (node as HTMLElement).getAttribute(WINDOW_ROW_ATTR);
      if (!key) continue;
      const h = (node as HTMLElement).getBoundingClientRect().height + ROW_GAP;
      if (h > ROW_GAP && measured.current.get(key) !== h) {
        measured.current.set(key, h);
        changed = true;
      }
    }
    if (!changed) return;
    const heights = heightsFor(keys, measured.current, FALLBACK_ROW);
    let padTopNow = 0;
    for (let i = 0; i < plan.start; i++) padTopNow += heights[i];
    const delta = padTopNow - plan.padTop;
    if (Math.abs(delta) < 1) return;
    // Grow or shrink the space above the viewport and move with it, so the row
    // the reader is looking at does not move at all.
    vp.scrollTop += delta;
    let padBottomNow = 0;
    for (let i = plan.end; i < heights.length; i++) padBottomNow += heights[i];
    setPlan((prev) => (prev.sig === sig ? { ...prev, padTop: padTopNow, padBottom: padBottomNow } : prev));
  });

  return { ...plan, active: keys.length > THRESHOLD };
}
