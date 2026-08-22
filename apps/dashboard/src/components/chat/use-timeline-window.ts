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
import {
  planWindow,
  fullWindow,
  heightsFor,
  liftFromSettled,
  fitProseHeights,
  type ProseFit,
  type SettledRow,
  type WindowPlan,
} from './timeline-window';
import { loadTextHeight, textHeightReady, proseHeight, fontOf } from '@/lib/text-height';

/** Below this many rows, render the whole thing and touch nothing. */
const THRESHOLD = 400;
/** Screens of extra rows kept mounted above and below the viewport. */
const OVERSCAN_SCREENS = 3;
/** Height assumed for a row nothing has been measured for yet. */
const FALLBACK_ROW = 90;
/** `space-y-3` between rows — part of the height an item occupies. */
const ROW_GAP = 12;
/**
 * Main-thread budget for one batch of prose predictions. Predicting a row costs
 * about 0.1ms warm, so a whole 4,000-row session is ~400ms — a long task and an
 * unacceptable one on a phone. Spent in idle slices instead: the estimates get
 * better as slices land, and every mechanism downstream already copes with an
 * estimate changing, because that is what a row mounting has always done.
 */
const PROSE_BUDGET_MS = 6;
/** Re-predict everything if the column changed width by more than this. */
const WIDTH_EPSILON = 2;

/** Marks a rendered item so the measurer can find it and know which row it is. */
export const WINDOW_ROW_ATTR = 'data-window-key';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

function noop(): void {}

/**
 * The last few hundred reading-position corrections the window made.
 *
 * Same reason as the prepend anchor's log: once history is loaded up front there
 * is no prepend left to blame, and the only thing still holding the reader while
 * they scroll is this — replacing a guessed row height with a measured one and
 * moving `scrollTop` by the difference. When that comes up short the reader
 * slides, and a description afterwards cannot say by how much or against what.
 * Dump it right after a jump:
 *   copy(JSON.stringify(window.__timelineWindowLog))
 */
const WINDOW_LOG_SIZE = 300;
type WindowLogEntry = {
  t: number;
  /** What the correction asked for, and what `scrollTop` actually moved by. */
  wanted: number;
  applied: number;
  start: number;
  end: number;
  padTopPlan: number;
  padTopNow: number;
  scrollTop: number;
  scrollHeight: number;
  rows: number;
  measured: number;
  /** Whether the prose fit was in play, and on how many samples. */
  fit: number;
};
const windowLog: WindowLogEntry[] = [];
function logWindow(e: WindowLogEntry): void {
  windowLog.push(e);
  if (windowLog.length > WINDOW_LOG_SIZE) windowLog.shift();
  if (typeof window !== 'undefined') {
    (window as unknown as { __timelineWindowLog?: WindowLogEntry[] }).__timelineWindowLog = windowLog;
  }
}

export type TimelineWindow = WindowPlan & {
  /** True while the list is actually being windowed. */
  active: boolean;
};

/** Identifies WHICH list a plan was computed for — see the correction below. */
function signature(keys: string[]): string {
  return `${keys.length}:${keys[0] ?? ''}:${keys[keys.length - 1] ?? ''}`;
}

export function useTimelineWindow(
  keys: string[],
  getViewport: () => HTMLElement | null,
  /**
   * A row's source text by index. An accessor rather than an array because a row
   * is predicted at most once and the answer is kept: materialising every row's
   * prose on every render would be thousands of strings built for the thirty the
   * predictor actually asks about. Optional — without it the window behaves
   * exactly as it did before prose prediction existed.
   */
  textAt?: (i: number) => string,
): TimelineWindow {
  const measured = useRef(new Map<string, number>());
  // Predicted prose height per row key, at `proseMetrics`' width. 0 means "asked
  // and there is no prose here" — a picture, a run capsule — which is a real
  // answer worth remembering, not a miss to retry every idle slice.
  const prose = useRef(new Map<string, number>());
  const proseMetrics = useRef<{ font: string; lineHeight: number; width: number } | null>(null);
  const fit = useRef<ProseFit | null>(null);
  const idleHandle = useRef<number | null>(null);
  // Correction that asked for more room than the scroller had — see below.
  const owed = useRef(0);
  const textAtRef = useRef<((i: number) => string) | undefined>(textAt);
  // `startKey` is what makes the window survive a prepend: see the remap below.
  const [plan, setPlan] = useState<WindowPlan & { sig: string; startKey: string | null }>(() => ({
    ...fullWindow(keys.length),
    sig: signature(keys),
    startKey: keys[0] ?? null,
  }));
  // Read by the scroll listener, which must not re-subscribe on every render.
  const keysRef = useRef(keys);
  // Read by the row observer below, which outlives any one render.
  const planRef = useRef(plan);
  useIsoLayoutEffect(() => {
    keysRef.current = keys;
    planRef.current = plan;
    textAtRef.current = textAt;
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
      heights: heightsFor(ks, measured.current, FALLBACK_ROW, prose.current, fit.current),
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
        const heights = heightsFor(keys, measured.current, FALLBACK_ROW, prose.current, fit.current);
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

  // Fold whatever has been measured into the plan, and hold the reading position
  // if the space above the viewport turned out to be a different size than we
  // had guessed. Called from the sweep below (synchronously, before paint) and
  // from the row observer (in the same frame's rendering step, also before
  // paint), so a row that settles never gets to shove the text.
  const applyMeasured = useCallback(() => {
    const vp = getViewport();
    const ks = keysRef.current;
    const p = planRef.current;
    // Only correct against a plan computed for THIS list. "Load earlier"
    // prepends a page, which shifts every index: the height above index `start`
    // then describes a different stretch of conversation than the plan's
    // `padTop` did, and the difference between them is not a measurement error
    // to be corrected — it is the prepend itself, which the prepend anchor is
    // already holding. Correcting it too moved the view by ~2,400px in one frame.
    if (!vp || ks.length <= THRESHOLD || p.sig !== signature(ks)) return;
    const heights = heightsFor(ks, measured.current, FALLBACK_ROW, prose.current, fit.current);
    let padTopNow = 0;
    for (let i = 0; i < p.start; i++) padTopNow += heights[i];
    const delta = padTopNow - p.padTop;
    if (Math.abs(delta) < 1) return;
    // Grow or shrink the space above the viewport and move with it, so the row
    // the reader is looking at does not move at all.
    const before = vp.scrollTop;
    vp.scrollTop += delta;
    // A correction that GROWS the space above the reader is asking `scrollTop`
    // to move somewhere the scroller cannot reach yet: the taller spacer is
    // still the plan's old height until React commits the setPlan below, so the
    // browser clamps the write and silently drops the rest. Shrinking never hits
    // this — a smaller `scrollTop` is always reachable — which is why it shows up
    // as a one-sided slide, only ever upward, and only on lists long enough for
    // the guesses above to be wrong by real distances. Measured on a 1,718-row
    // session: a correction of 25,430px landed 1,727px of itself and the reader
    // lost the other 23,703px in one frame.
    //
    // So keep the remainder and pay it in the layout effect below, once the
    // spacer that makes room for it exists.
    const applied = vp.scrollTop - before;
    if (Math.abs(delta - applied) >= 1) owed.current += delta - applied;
    logWindow({
      t: Date.now(), wanted: delta, applied: vp.scrollTop - before,
      start: p.start, end: p.end, padTopPlan: p.padTop, padTopNow,
      scrollTop: vp.scrollTop, scrollHeight: vp.scrollHeight,
      rows: ks.length, measured: measured.current.size, fit: fit.current ? fit.current.samples : 0,
    });
    let padBottomNow = 0;
    for (let i = p.end; i < heights.length; i++) padBottomNow += heights[i];
    setPlan((prev) => (prev.sig === p.sig ? { ...prev, padTop: padTopNow, padBottom: padBottomNow } : prev));
  }, [getViewport]);

  // Predicting the rows nobody has seen.
  //
  // The mean of what has been measured is the same number for every unmeasured
  // row, so a one-line "好的。" and a page of markdown are guessed identically and
  // the difference arrives as a scroll correction the moment either one mounts.
  // pretext lays the row's own prose out at the column's width without touching
  // the DOM (see lib/text-height.ts), and fitProseHeights learns what that
  // predicts about a real row from the rows already measured — so nothing here
  // hard-codes a padding, a margin or a font.
  //
  // Done in idle slices with a millisecond budget, not in one pass: the whole of
  // a 4,000-row session is ~400ms of work, which as a single task is a visibly
  // dropped second on a phone.
  //
  // Only `applyMeasured` runs afterwards, deliberately — it moves `scrollTop` by
  // exactly the amount the space above the viewport just changed, which is what
  // makes a better estimate invisible to the reader instead of a jump. Replanning
  // the window is left to the next scroll, which is a few ms away anyway.
  const refit = useCallback(() => {
    const pairs: Array<{ prose: number; real: number }> = [];
    for (const [k, real] of measured.current) {
      const p = prose.current.get(k);
      if (p !== undefined && p > 0) pairs.push({ prose: p, real });
    }
    fit.current = fitProseHeights(pairs);
  }, []);

  // Self-rescheduling through a ref rather than through the dependency array:
  // a slice that runs out of budget has to queue the next one, and a callback
  // cannot list itself as its own dependency.
  const predictRef = useRef<() => void>(noop);
  const schedulePredict = useCallback(() => {
    if (idleHandle.current !== null) return;
    const run = () => predictRef.current();
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    idleHandle.current = ric ? ric(run, { timeout: 500 }) : (setTimeout(run, 50) as unknown as number);
  }, []);

  const predict = useCallback(() => {
    idleHandle.current = null;
    const ks = keysRef.current;
    const textOf = textAtRef.current;
    const m = proseMetrics.current;
    if (!m || !textOf || ks.length <= THRESHOLD || !textHeightReady()) return;
    const deadline = performance.now() + PROSE_BUDGET_MS;
    let did = 0;
    let more = false;
    for (let i = 0; i < ks.length; i++) {
      if (prose.current.has(ks[i])) continue;
      if (performance.now() > deadline) {
        more = true;
        break;
      }
      const t = textOf(i);
      const r = t ? proseHeight(t, m) : { height: 0, blocks: 0 };
      prose.current.set(ks[i], r.blocks > 0 ? r.height : 0);
      did++;
    }
    if (!did) return;
    refit();
    applyMeasured();
    if (more) schedulePredict();
  }, [applyMeasured, refit, schedulePredict]);

  // Declared after `predict` on purpose: an idle slice that runs out of budget
  // queues the next one through this ref, and a callback cannot name itself in
  // its own dependency array.
  useIsoLayoutEffect(() => {
    predictRef.current = predict;
  });

  // Kick the loader once, and only for lists big enough to be windowed at all.
  useEffect(() => {
    if (keys.length > THRESHOLD) loadTextHeight();
  }, [keys.length]);

  useEffect(() => {
    if (keys.length <= THRESHOLD) return;
    schedulePredict();
  }, [keys.length, sig, schedulePredict]);

  useEffect(
    () => () => {
      if (idleHandle.current === null) return;
      const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      if (cic) cic(idleHandle.current);
      else clearTimeout(idleHandle.current);
      idleHandle.current = null;
    },
    [],
  );

  // Pay back whatever the correction above could not fit.
  //
  // By now the plan it was computed for has been committed, so the top spacer is
  // its new height and the scroller is finally tall enough to hold the position
  // it was asked to hold. This is a layout effect on the plan itself, so it runs
  // in the same commit — before the browser paints, and therefore before the
  // reader could see the frame where it had not been paid.
  //
  // One attempt. If it still will not fit, something other than the spacer is
  // wrong and re-trying every commit would be a scroll that fights the reader
  // rather than a correction that holds them.
  useIsoLayoutEffect(() => {
    const debt = owed.current;
    if (!debt) return;
    owed.current = 0;
    const vp = getViewport();
    if (!vp) return;
    const before = vp.scrollTop;
    vp.scrollTop += debt;
    const paid = vp.scrollTop - before;
    if (Math.abs(debt - paid) >= 1) {
      logWindow({
        t: Date.now(), wanted: debt, applied: paid,
        start: plan.start, end: plan.end, padTopPlan: plan.padTop, padTopNow: plan.padTop,
        scrollTop: vp.scrollTop, scrollHeight: vp.scrollHeight,
        rows: keysRef.current.length, measured: measured.current.size, fit: fit.current ? fit.current.samples : 0,
      });
    }
  }, [plan, getViewport]);

  // A row's height is wanted for two different reasons, and they want it at two
  // different moments:
  //
  //   · A row that has just mounted is replacing a GUESS. That has to be
  //     measured here and now, in the layout effect, because the guess is part
  //     of the space above the viewport and the correction must land before the
  //     browser paints.
  //   · A row that has been on screen for a while only changes height when its
  //     content settles — markdown, a code block gaining a scrollbar, an image
  //     resolving. Re-reading every mounted row on every render to catch that
  //     was both the most expensive thing this hook did (~22 forced-layout rect
  //     reads per scroll step, the hottest app frame in a windowed timeline) and
  //     unreliable, since it only ever noticed a settle that happened to be
  //     followed by a render.
  //
  // So: measure the new ones here, and let a ResizeObserver hand us the rest.
  // It reports sizes the browser has already computed — no forced layout — and
  // it fires whether or not anything re-rendered.
  const rowObserver = useRef<ResizeObserver | null>(null);
  const observedRows = useRef(new Set<Element>());
  useIsoLayoutEffect(() => {
    const vp = getViewport();
    if (!vp || keys.length <= THRESHOLD) return;
    if (plan.sig !== sig) return;
    let ro = rowObserver.current;
    if (!ro && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        let dirty = false;
        // A row that settles above the reader shoves them down by however much
        // it grew, and `padTop` cannot see it happen — the row is mounted, so it
        // is not part of `padTop` at all. Collect the changes here and undo the
        // total once, below. Reading rects inside a ResizeObserver callback is
        // free: it runs after layout, so nothing is dirty to force.
        const vp = getViewport();
        const viewportTop = vp ? vp.getBoundingClientRect().top : 0;
        const settled: SettledRow[] = [];
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).getAttribute(WINDOW_ROW_ATTR);
          if (!key) continue;
          const h = (entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height) + ROW_GAP;
          if (h <= ROW_GAP) continue;
          const was = measured.current.get(key);
          if (was === h) continue;
          measured.current.set(key, h);
          dirty = true;
          // `was === undefined` is a first measurement, not a settle: the row
          // was a guess in `padTop` until this moment, and undoing a guess is
          // `applyMeasured`'s job, not this one. Counting it here would correct
          // the same pixels twice.
          if (was !== undefined && vp) {
            settled.push({ was, now: h, bottom: (entry.target as HTMLElement).getBoundingClientRect().bottom });
          }
        }
        if (vp && settled.length) {
          const lift = liftFromSettled(settled, viewportTop);
          // Reads to the prepend anchor as a scroll it did not make — i.e. as
          // the user — which is exactly how it already treats `applyMeasured`'s
          // correction, so the two compose instead of fighting.
          if (lift !== 0) vp.scrollTop += lift;
        }
        if (dirty) applyMeasured();
      });
      rowObserver.current = ro;
    }
    let changed = false;
    // What the prose predictor lays text out with, taken from a row that is
    // actually on screen rather than assumed: the font follows the theme and
    // whatever next/font named the family this build, and the width follows the
    // column, which is not the viewport (there is a max-width and padding).
    // A width change invalidates every prediction — line breaks move — so the
    // cache is dropped and refilled in idle slices, same as the first fill.
    let firstRow: HTMLElement | null = null;
    // The rows live inside the viewport we already have — no second ref needed.
    const live = new Set<Element>();
    for (const node of vp.querySelectorAll(`[${WINDOW_ROW_ATTR}]`)) {
      live.add(node);
      if (!firstRow) firstRow = node as HTMLElement;
      const key = node.getAttribute(WINDOW_ROW_ATTR);
      if (!key) continue;
      if (ro && !observedRows.current.has(node)) {
        ro.observe(node);
        observedRows.current.add(node);
      }
      if (measured.current.has(key)) continue;
      const h = (node as HTMLElement).getBoundingClientRect().height + ROW_GAP;
      if (h > ROW_GAP) {
        measured.current.set(key, h);
        changed = true;
      }
    }
    if (firstRow && keys.length > THRESHOLD) {
      const width = firstRow.getBoundingClientRect().width;
      const prev = proseMetrics.current;
      if (width > 0 && (!prev || Math.abs(prev.width - width) > WIDTH_EPSILON)) {
        proseMetrics.current = { ...fontOf(firstRow), width };
        prose.current.clear();
        fit.current = null;
        schedulePredict();
      } else if (prev && prose.current.size < keys.length) {
        schedulePredict();
      }
    }
    // Windowed-out rows are detached; keep the observer from holding them.
    for (const node of observedRows.current) {
      if (live.has(node)) continue;
      ro?.unobserve(node);
      observedRows.current.delete(node);
    }
    // A measurement is also a new data point for the fit between predicted prose
    // and real rows — that is what makes the prediction get better with use.
    if (changed) {
      refit();
      applyMeasured();
    }
  });

  useEffect(
    () => () => {
      rowObserver.current?.disconnect();
      rowObserver.current = null;
      observedRows.current.clear();
    },
    []
  );

  return { ...plan, active: keys.length > THRESHOLD };
}
