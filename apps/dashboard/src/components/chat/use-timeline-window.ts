'use client';

// Keeps only the part of a long timeline that is near the viewport in the DOM,
// with spacers standing in for the rest. See timeline-window.ts for why, and for
// the arithmetic.
//
// Two things make this safe to bolt onto a list that is also being scrolled,
// anchored, and prepended to:
//
//   · Below the threshold no row leaves the DOM and no spacer planning runs. A
//     ResizeObserver still watches mounted rows, because late content changes can
//     move a reader in a short conversation too.
//   · The reading position is held across every window change. A row that has
//     never been on screen is a guess until it is rendered, so replacing that
//     guess with a measurement changes the height ABOVE the viewport, which
//     would shove the text under the reader's eyes. A shared compositor transform
//     absorbs that movement; one scrollTop settlement happens only after native
//     scrolling has stopped.
//
// That correction composes with the prepend anchor rather than fighting it: both
// use the same controller, whose reader-only coordinate removes app compensation
// while leaving native input visible (see scroll-stability-core.ts).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  planWindow,
  fullWindow,
  heightsFor,
  liftFromSettled,
  clampPlan,
  fitProseHeights,
  type ProseFit,
  type SettledRow,
  type WindowPlan,
  TIMELINE_ROW_GAP,
  shouldWindow,
} from './timeline-window';
import { loadTextHeight, textHeightReady, proseHeight, fontOf } from '@/lib/text-height';
import { getHeights, putHeights, evictHeightsLru, widthBucket } from '@/lib/chat-cache/db';
import { currentScope } from '@/lib/chat-cache/sync';
import type { ScrollStability } from './use-scroll-stability';

/**
 * When to window at all.
 *
 * A row count is the wrong question, and asking it is what left a real session
 * scrolling at five frames a second. `foldRuns` collapses a tool chain into one
 * capsule, so how many rows a conversation has says nothing about what they
 * weigh: an agent that mostly runs tools folds around thirteen messages into
 * each row, and 6,941 messages became 279 rows — under any sane row threshold —
 * carrying 4,818 DOM nodes and sixty-four screens of content. Measured on that
 * session with windowing off: 189ms per frame. With it on: 17ms.
 *
 * So ask what is actually expensive. Content far taller than the viewport means
 * most of it is off screen whatever the row count, and that is exactly the
 * condition windowing exists for.
 */
const THRESHOLD = 400;
const WINDOW_SCREENS = 12;
const MIN_WINDOW_ROWS = 60;
/** Screens of extra rows kept mounted above and below the viewport. */
const OVERSCAN_SCREENS = 3;
/** Height assumed for a row nothing has been measured for yet. */
const FALLBACK_ROW = 90;
/** `gap-3` between rows — part of the height an item occupies. */
const ROW_GAP = TIMELINE_ROW_GAP;
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
/** Quiet period before measured heights are written back to disk. */
const HEIGHTS_SAVE_MS = 2_000;

/** Marks a rendered item so the measurer can find it and know which row it is. */
export const WINDOW_ROW_ATTR = 'data-window-key';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

function noop(): void {}

type PredictHandle = { kind: 'idle' | 'timeout'; id: number };

function cancelPredictHandle(handle: PredictHandle): void {
  if (handle.kind === 'idle') {
    (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(handle.id);
  } else {
    window.clearTimeout(handle.id);
  }
}

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
  /** Which conversation these heights belong to, for keeping them on disk. */
  sessionId?: string,
  /** Shared with the prepend anchor so every correction respects momentum. */
  stability?: ScrollStability,
  /**
   * Let an active prepend anchor consume the current geometry change. It
   * returns true even when a previous callback in this frame already restored
   * the anchor, making correction idempotent whichever observer runs first.
   */
  settlePrepend?: () => boolean,
): TimelineWindow {
  const measured = useRef(new Map<string, number>());
  // Predicted prose height per row key, at `proseMetrics`' width. 0 means "asked
  // and there is no prose here" — a picture, a run capsule — which is a real
  // answer worth remembering, not a miss to retry every idle slice.
  const prose = useRef(new Map<string, number>());
  const proseMetrics = useRef<{ font: string; lineHeight: number; width: number } | null>(null);
  const fit = useRef<ProseFit | null>(null);
  const idleHandle = useRef<PredictHandle | null>(null);
  // Bookkeeping for keeping measured heights across a reload.
  const saveHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedKey = useRef<string | null>(null);
  const seedGeneration = useRef(0);
  const dirtyHeights = useRef(false);
  /** Width bucket that every entry in `measured` belongs to. */
  const measuredWidth = useRef<number | null>(null);
  /** Rows that stayed mounted across a width change, for exact reflow lift. */
  const previousWidthHeights = useRef<Map<string, number> | null>(null);
  const widthReflowRows = useRef(new Set<Element>());
  const [heightScopeRevision, setHeightScopeRevision] = useState(0);
  const rowObserver = useRef<ResizeObserver | null>(null);
  const observedRows = useRef(new Set<Element>());
  const textAtRef = useRef<((i: number) => string) | undefined>(textAt);
  // `startKey` is what makes the window survive a prepend: see the remap below.
  type PlanState = WindowPlan & { sig: string; startKey: string | null; rev: number };
  const [plan, setPlan] = useState<PlanState>(() => ({
    ...fullWindow(keys.length),
    sig: signature(keys),
    startKey: keys[0] ?? null,
    rev: 0,
  }));
  // Read by the scroll listener, which must not re-subscribe on every render.
  const keysRef = useRef(keys);
  // Read by the row observer below, which outlives any one render.
  const planRef = useRef(plan);
  // Unlike planRef (which advances as soon as work is queued), this is the last
  // geometry React has actually put in the DOM. Width resets must restart here:
  // a queued old-width plan may be batched away and never become visible.
  const committedPlanRef = useRef(plan);
  const pendingPlanShifts = useRef<Array<{ rev: number; delta: number }>>([]);
  const plannedHeights = useRef<{ sig: string; keys: string[]; values: number[] } | null>(null);
  // Latched, but never activated during a native gesture. The old implementation
  // flipped this inside the scroll callback and synchronously measured every DOM
  // row there — exactly the periodic hitch reported on recent conversations.
  const windowedRef = useRef(false);
  useIsoLayoutEffect(() => {
    keysRef.current = keys;
    planRef.current = plan;
    committedPlanRef.current = plan;
    textAtRef.current = textAt;
  });

  const compensateVisual = useCallback((delta: number, reason: string): number => {
    // A prepend anchor and the timeline observer can see the same row growth in
    // one frame. Always ask the anchor first, even for a zero timeline lift: a
    // visible row can move the held tail/anchor although liftFromSettled quite
    // correctly leaves ordinary visible content alone. If the anchor already
    // corrected in rAF, this reassert is a no-op and still claims the change.
    if (settlePrepend?.()) return 0;
    if (delta === 0) return 0;
    return stability?.compensate(delta, reason) ?? 0;
  }, [settlePrepend, stability]);

  const isWindowed = useCallback((): boolean => {
    if (windowedRef.current) return true;
    const vp = getViewport();
    const rows = keysRef.current.length;
    if (!vp) return false;
    // A 279-row tool-heavy session can still carry 4,800 DOM nodes and sixty-four
    // screens. Keep the weight trigger, but only engage it after momentum stops;
    // the ResizeObserver has measured the mounted rows by then, so activation is
    // an exact spacer swap rather than a scroll-time guessing pass.
    if (stability?.isScrolling()) return false;
    const yes = shouldWindow({
      rows,
      // Honest height: a held downward correction is painted as a translate,
      // which adds its own size to vp.scrollHeight and would trip the
      // twelve-screens test on a list that is not that tall.
      scrollHeight: stability?.contentHeight() ?? vp.scrollHeight,
      clientHeight: vp.clientHeight,
      rowLimit: THRESHOLD,
      screens: WINDOW_SCREENS,
      minRows: MIN_WINDOW_ROWS,
    });
    if (yes) {
      // Activation replaces a fully-mounted list with spacers. Take an exact
      // snapshot while every row is still present, but only in this quiet path —
      // never from the native scroll callback that discovered the height.
      for (const node of vp.querySelectorAll(`[${WINDOW_ROW_ATTR}]`)) {
        const key = node.getAttribute(WINDOW_ROW_ATTR);
        if (!key || measured.current.has(key)) continue;
        const h = (node as HTMLElement).getBoundingClientRect().height + ROW_GAP;
        if (h > ROW_GAP) measured.current.set(key, h);
      }
      windowedRef.current = true;
    }
    return yes;
  }, [getViewport, stability]);

  const queuePlan = useCallback((next: Omit<PlanState, 'rev'>, shiftAfterCommit = 0) => {
    const current = planRef.current;
    if (
      current.sig === next.sig && current.start === next.start && current.end === next.end
      && current.padTop === next.padTop && current.padBottom === next.padBottom
      && current.startKey === next.startKey
    ) return;
    const queued = { ...next, rev: current.rev + 1 };
    planRef.current = queued;
    if (shiftAfterCommit !== 0) pendingPlanShifts.current.push({ rev: queued.rev, delta: shiftAfterCommit });
    setPlan(queued);
  }, []);

  const resetHeightScope = useCallback((vp: HTMLElement): boolean => {
    const nextWidth = widthBucket(vp.clientWidth);
    if (measuredWidth.current === null) {
      measuredWidth.current = nextWidth;
      return false;
    }
    if (measuredWidth.current === nextWidth) return false;

    // Cancel any old-width plan that React has not committed. Clearing its
    // compensation ledger alone is insufficient: the queued geometry could
    // still commit and move the reader with no matching correction. Re-queue
    // the last DOM-confirmed geometry at a newer revision so React either keeps
    // what is already visible or supersedes an old-width update atomically.
    const committed = committedPlanRef.current;
    const resetPlan = {
      ...committed,
      rev: Math.max(planRef.current.rev, committed.rev) + 1,
    };
    planRef.current = resetPlan;
    setPlan(resetPlan);

    // A row height is only true at the width where it was measured. Keeping the
    // old map after a rotation makes every off-screen spacer wrong, and those
    // errors arrive later as large corrections during a perfectly ordinary
    // fling. Keep the old values only long enough to compensate rows that were
    // physically mounted across this reflow; planners immediately see a fresh
    // map scoped to the new width.
    previousWidthHeights.current = measured.current;
    widthReflowRows.current = new Set(observedRows.current);
    measured.current = new Map();
    measuredWidth.current = nextWidth;
    prose.current.clear();
    proseMetrics.current = null;
    fit.current = null;
    plannedHeights.current = null;
    pendingPlanShifts.current = [];
    savedKey.current = null;
    seedGeneration.current += 1;
    dirtyHeights.current = false;
    if (saveHandle.current !== null) {
      clearTimeout(saveHandle.current);
      saveHandle.current = null;
    }
    if (idleHandle.current !== null) {
      cancelPredictHandle(idleHandle.current);
      idleHandle.current = null;
    }
    setHeightScopeRevision((revision) => revision + 1);
    return true;
  }, []);

  const recompute = useCallback(() => {
    const vp = getViewport();
    const ks = keysRef.current;
    const sig = signature(ks);
    if (!vp || !isWindowed()) {
      queuePlan({ ...fullWindow(ks.length), sig, startKey: ks[0] ?? null });
      return;
    }
    const heights = heightsFor(ks, measured.current, FALLBACK_ROW, prose.current, fit.current);
    plannedHeights.current = { sig, keys: ks, values: heights };
    const next = planWindow({
      heights,
      scrollTop: stability?.logicalScrollTop() ?? vp.scrollTop,
      viewportHeight: vp.clientHeight,
      overscan: vp.clientHeight * OVERSCAN_SCREENS,
      // The decision was made above; the planner must not second-guess it with a
      // row count of its own.
      threshold: 0,
    });
    queuePlan({ ...next, sig, startKey: ks[next.start] ?? null });
  }, [getViewport, isWindowed, queuePlan, stability]);

  // Recompute at most once per animation frame. A WebKit scroll event can arrive
  // faster than paint; walking thousands of heights for every one made the odd
  // event burst show up as a periodic long frame.
  useEffect(() => {
    const vp = getViewport();
    if (!vp) return;
    let raf = 0;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    const onScroll = () => {
      schedule();
      if (quietTimer !== null) clearTimeout(quietTimer);
      // Gives the stability controller's 180ms quiet detector time to close
      // before a weight-based window is allowed to activate.
      quietTimer = setTimeout(recompute, 220);
    };
    vp.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      resetHeightScope(vp);
      schedule();
    });
    ro.observe(vp);
    return () => {
      vp.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (quietTimer !== null) clearTimeout(quietTimer);
    };
  }, [getViewport, recompute, resetHeightScope]);

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
    const currentKeys = keysRef.current;
    const current = planRef.current;
    if (isWindowed() && current.startKey && current.sig !== sig) {
      const at = currentKeys.indexOf(current.startKey);
      if (at >= 0) {
        const span = Math.max(1, current.end - current.start);
        const heights = heightsFor(currentKeys, measured.current, FALLBACK_ROW, prose.current, fit.current);
        plannedHeights.current = { sig, keys: currentKeys, values: heights };
        const end = Math.min(currentKeys.length, at + span);
        let padTop = 0;
        for (let i = 0; i < at; i++) padTop += heights[i];
        let padBottom = 0;
        for (let i = end; i < currentKeys.length; i++) padBottom += heights[i];
        queuePlan({ start: at, end, padTop, padBottom, sig, startKey: current.startKey });
        return;
      }
    }
    recompute();
  }, [sig, recompute, isWindowed, queuePlan]);

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
    if (!vp || !isWindowed() || p.sig !== signature(ks)) return;
    const heights = heightsFor(ks, measured.current, FALLBACK_ROW, prose.current, fit.current);
    let padTopNow = 0;
    for (let i = 0; i < p.start; i++) padTopNow += heights[i];
    const delta = padTopNow - p.padTop;
    let padBottomNow = 0;
    for (let i = p.end; i < heights.length; i++) padBottomNow += heights[i];
    if (delta === 0 && padBottomNow === p.padBottom) return;
    // The transform must land only AFTER React has committed the new spacer.
    // Applying it against the old DOM would create the very one-frame jump this
    // path exists to prevent.
    queuePlan({
      start: p.start, end: p.end, padTop: padTopNow, padBottom: padBottomNow,
      sig: p.sig, startKey: p.startKey,
    }, delta);
  }, [getViewport, isWindowed, queuePlan]);

  // Drain geometry shifts for every plan React folded into this commit. The new
  // spacer exists now, but the browser has not painted it yet.
  useIsoLayoutEffect(() => {
    let shift = 0;
    const rest: Array<{ rev: number; delta: number }> = [];
    for (const pending of pendingPlanShifts.current) {
      if (pending.rev <= plan.rev) shift += pending.delta;
      else rest.push(pending);
    }
    pendingPlanShifts.current = rest;
    if (shift !== 0) {
      const applied = compensateVisual(shift, 'window-pad');
      const vp = getViewport();
      if (vp) {
        logWindow({
          t: Date.now(), wanted: shift, applied,
          start: plan.start, end: plan.end, padTopPlan: plan.padTop - shift, padTopNow: plan.padTop,
          scrollTop: vp.scrollTop, scrollHeight: vp.scrollHeight,
          rows: keysRef.current.length, measured: measured.current.size,
          fit: fit.current ? fit.current.samples : 0,
        });
      }
    }
  }, [plan.rev, compensateVisual, getViewport]);

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
    const run = () => {
      // The callback that owned this handle is running now. Clear it before
      // choosing a successor so reset/unmount always cancels the right API.
      idleHandle.current = null;
      if (stability?.isScrolling()) {
        idleHandle.current = { kind: 'timeout', id: window.setTimeout(run, 200) };
        return;
      }
      predictRef.current();
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    idleHandle.current = ric
      ? { kind: 'idle', id: ric(run, { timeout: 500 }) }
      : { kind: 'timeout', id: window.setTimeout(run, 50) };
  }, [stability]);

  const predict = useCallback(() => {
    idleHandle.current = null;
    const ks = keysRef.current;
    const textOf = textAtRef.current;
    const m = proseMetrics.current;
    if (!m || !textOf || !isWindowed() || !textHeightReady()) return;
    if (stability?.isScrolling()) {
      schedulePredict();
      return;
    }
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
  }, [applyMeasured, refit, schedulePredict, isWindowed, stability]);

  // Declared after `predict` on purpose: an idle slice that runs out of budget
  // queues the next one through this ref, and a callback cannot name itself in
  // its own dependency array.
  useIsoLayoutEffect(() => {
    predictRef.current = predict;
  });

  // ── keep what has been measured, across reloads ────────────────────────────
  //
  // A prediction is a guess that gets corrected the moment the row appears, and
  // the correction moves the reader. A measurement does not need predicting at
  // all — and a row the reader has already scrolled past has been measured, so
  // throwing that away when the tab closes means paying for the same guess again
  // tomorrow. Kept per session and per column width, because a height is only
  // true at the width it was taken at.
  const seedFromDisk = useCallback(async () => {
    const vp = getViewport();
    const scope = currentScope();
    if (!vp || !scope || !sessionId) return;
    const width = widthBucket(vp.clientWidth);
    resetHeightScope(vp);
    const key = `${sessionId}:${width}`;
    if (savedKey.current === key) return;
    savedKey.current = key;
    const generation = ++seedGeneration.current;
    const stored = await getHeights(scope, sessionId, width);
    const liveViewport = getViewport();
    if (
      generation !== seedGeneration.current
      || savedKey.current !== key
      || liveViewport !== vp
      || widthBucket(liveViewport.clientWidth) !== width
    ) return;
    let added = 0;
    for (const [k, h] of Object.entries(stored)) {
      // Never overwrite something measured in THIS session: the row may have
      // grown since (an image arrived, a capsule was expanded) and the live
      // measurement is the true one.
      if (h > 0 && !measured.current.has(k)) {
        measured.current.set(k, h);
        added++;
      }
    }
    if (!added) return;
    refit();
    applyMeasured();
  }, [getViewport, sessionId, refit, applyMeasured, resetHeightScope]);

  useEffect(() => {
    void seedFromDisk();
  }, [seedFromDisk, heightScopeRevision]);

  useEffect(() => () => {
    seedGeneration.current += 1;
  }, []);

  const scheduleSave = useCallback(() => {
    dirtyHeights.current = true;
    if (saveHandle.current !== null) return;
    saveHandle.current = setTimeout(() => {
      saveHandle.current = null;
      if (!dirtyHeights.current) return;
      dirtyHeights.current = false;
      const vp = getViewport();
      const scope = currentScope();
      if (!vp || !scope || !sessionId || measured.current.size === 0) return;
      const width = measuredWidth.current;
      // `measured` belongs to one width bucket. A resize can change clientWidth
      // just before its ResizeObserver resets the map; never write that old map
      // under the already-new DOM width during this narrow interval.
      if (width === null || widthBucket(vp.clientWidth) !== width) return;
      const snapshot: Record<string, number> = {};
      for (const [k, h] of measured.current) snapshot[k] = h;
      void putHeights(scope, sessionId, width, snapshot)
        .then(() => evictHeightsLru(scope))
        .catch(() => {});
    }, HEIGHTS_SAVE_MS);
  }, [getViewport, sessionId]);

  useEffect(
    () => () => {
      if (saveHandle.current !== null) clearTimeout(saveHandle.current);
      saveHandle.current = null;
    },
    []
  );

  // Kick the loader once, and only for lists big enough to be windowed at all.
  useEffect(() => {
    if (isWindowed()) loadTextHeight();
  }, [keys.length, isWindowed]);

  useEffect(() => {
    if (!isWindowed()) return;
    schedulePredict();
  }, [keys.length, sig, schedulePredict, isWindowed]);

  useEffect(
    () => () => {
      if (idleHandle.current === null) return;
      cancelPredictHandle(idleHandle.current);
      idleHandle.current = null;
    },
    [],
  );

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
  useIsoLayoutEffect(() => {
    const vp = getViewport();
    if (!vp) return;
    // Below the threshold there is no window, no plan and nothing to measure for
    // — but rows still settle above the reader and still shove them, so the
    // observer runs whatever the list length. A short conversation with
    // auto-translate on is exactly that case: every English reply is replaced by
    // a shorter Chinese one seconds after it renders, and until now nothing gave
    // those pixels back because the observer was inside the windowing branch.
    const windowed = isWindowed();
    if (windowed && plan.sig !== sig) return;
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
          const target = entry.target as HTMLElement;
          const key = target.getAttribute(WINDOW_ROW_ATTR);
          if (!key) continue;
          const h = (entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height) + ROW_GAP;
          if (h <= ROW_GAP) continue;
          const was = measured.current.get(key);
          const crossedWidth = widthReflowRows.current.has(target);
          const beforeWidth = crossedWidth ? previousWidthHeights.current?.get(key) : undefined;
          if (crossedWidth) widthReflowRows.current.delete(target);
          if (was === h) continue;
          measured.current.set(key, h);
          dirty = true;
          // `was === undefined` is a first measurement, not a settle: the row
          // was a guess in `padTop` until this moment, and undoing a guess is
          // `applyMeasured`'s job, not this one. Counting it here would correct
          // the same pixels twice.
          const before = was ?? beforeWidth;
          if (before !== undefined && vp) {
            settled.push({ was: before, now: h, bottom: target.getBoundingClientRect().bottom });
          }
        }
        if (vp && settled.length) {
          const lift = liftFromSettled(settled, viewportTop);
          // Reads to the prepend anchor as a scroll it did not make — i.e. as
          // the user — which is exactly how it already treats `applyMeasured`'s
          // correction, so the two compose instead of fighting.
          const applied = compensateVisual(lift, 'settled-row');
          logWindow({
            t: Date.now(), wanted: lift, applied,
            start: -1, end: settled.length, padTopPlan: 0, padTopNow: 0,
            scrollTop: vp.scrollTop, scrollHeight: vp.scrollHeight,
            rows: keysRef.current.length, measured: measured.current.size,
            fit: fit.current ? fit.current.samples : 0,
          });
        }
        // `applyMeasured` and the write-back are about ESTIMATES, which only
        // exist when the list is windowed. The lift above is about the reader,
        // who is there either way.
        if (dirty && windowedRef.current) {
          applyMeasured();
          scheduleSave();
        }
      });
      rowObserver.current = ro;
    }
    let changed = false;
    const firstMounted: SettledRow[] = [];
    const viewportTop = vp.getBoundingClientRect().top;
    const snapshot = plannedHeights.current?.sig === sig
      ? plannedHeights.current
      : { sig, keys: keysRef.current, values: heightsFor(keysRef.current, measured.current, FALLBACK_ROW, prose.current, fit.current) };
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
      // Measuring is only worth its forced layout when something reads the
      // number, and only a windowed list does.
      if (!windowed || measured.current.has(key)) continue;
      const h = (node as HTMLElement).getBoundingClientRect().height + ROW_GAP;
      if (h > ROW_GAP) {
        const at = snapshot.keys.indexOf(key);
        const crossedWidth = widthReflowRows.current.has(node);
        const beforeWidth = crossedWidth ? previousWidthHeights.current?.get(key) : undefined;
        if (crossedWidth) widthReflowRows.current.delete(node);
        const was = beforeWidth ?? (at >= 0 ? snapshot.values[at] : FALLBACK_ROW);
        if (was !== h) {
          firstMounted.push({ was, now: h, bottom: (node as HTMLElement).getBoundingClientRect().bottom });
        }
        measured.current.set(key, h);
        changed = true;
      }
    }
    if (firstMounted.length) {
      const lift = liftFromSettled(firstMounted, viewportTop);
      compensateVisual(lift, 'first-mounted-row');
    }
    if (firstRow && windowed) {
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
      scheduleSave();
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

  // Clamped here, at the source. A stale plan is a normal state — it is React
  // state, and the replan is a layout effect — so every consumer would otherwise
  // have to remember, and one of them not remembering is what took the dashboard
  // down. See clampPlan.
  // Derived from the plan rather than read off the latch: a ref may not be read
  // during render, and "are we rendering less than the whole list" is the same
  // answer anyway.
  const clamped = clampPlan(plan, keys.length);
  return { ...clamped, active: clamped.end - clamped.start < keys.length };
}
