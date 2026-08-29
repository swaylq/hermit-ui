'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  acceptableCompensation,
  contentHeight as trueContentHeight,
  discardSubpixelDeviation,
  isVerticalWheelInput,
  logicalScrollTop as logicalTop,
  planBoundaryRebase,
  readerScrollTop as readerTop,
  scrollerIsUnanchored,
  trimOutOfRangeDeviation,
} from './scroll-stability-core';

/** No native scroll events for this long means WebKit momentum has ended. */
const SCROLL_QUIET_MS = 180;
/** A sub-pixel correction is not worth a momentum-ending setter call. */
const SETTLE_EPSILON = 1;

export type ScrollStability = {
  /**
   * Hold a would-be scrollTop correction in the compositor layer. This never
   * writes the viewport, whether the reader is touching it or momentum is still
   * running.
   *
   * `bounded` restores what a `scrollTop` write used to give the caller: the
   * correction stops at the ends of the content and the return value says how
   * much was taken. Only for callers that reconcile the shortfall — the prepend
   * anchor does, through `settledHold`. A caller that discards the return value
   * must stay unbounded, or a refused correction is a jump nothing undoes.
   */
  compensate: (delta: number, reason: string, bounded?: boolean) => number;
  /** Natural timeline coordinate currently at the viewport top. */
  logicalScrollTop: () => number;
  /**
   * Content height with this controller's held transform discounted. Every
   * "how far from the end" question must use this, not `el.scrollHeight`.
   */
  contentHeight: () => number;
  /** The largest honest `scrollTop`, i.e. `contentHeight() - clientHeight`. */
  maxScrollTop: () => number;
  /** Coordinate that changes only for native reader input, not app correction. */
  readerScrollTop: () => number;
  /** Programmatic navigation that first takes over any held transform. */
  scrollTo: (top: number, behavior: ScrollBehavior, reason: string) => number;
  /** Same, expressed as a delta in the currently visible coordinate. */
  scrollBy: (delta: number, behavior: ScrollBehavior, reason: string) => number;
  getDeviation: () => number;
  isScrolling: () => boolean;
  /** True when recent movement came from an actual reader input device. */
  hasReaderIntent: () => boolean;
  /** Recent raw input is upward or directionless (for a scrollbar/first frame). */
  hasUpwardReaderIntent: () => boolean;
  /** The latest upward input found logical history behind physical top zero. */
  hasBlockedUpwardIntent: () => boolean;
  /** True while the current scroll event belongs to app navigation/settlement. */
  isProgrammatic: () => boolean;
};

type ProgrammaticMotion =
  | { kind: 'instant'; expectedTop: number }
  | { kind: 'smooth'; lastTop: number };

type StabilityLogEntry = {
  t: number;
  kind: 'hold' | 'settle' | 'intent';
  reason: string;
  wanted: number;
  applied: number;
  deviation: number;
  scrollTop: number;
};

const LOG_SIZE = 300;
const stabilityLog: StabilityLogEntry[] = [];
/** Layers whose overflow-anchor has already been checked — see assertUnanchored. */
const checkedLayers = new WeakSet<HTMLElement>();
function log(entry: StabilityLogEntry): void {
  stabilityLog.push(entry);
  if (stabilityLog.length > LOG_SIZE) stabilityLog.shift();
  if (typeof window !== 'undefined') {
    (window as unknown as { __scrollStabilityLog?: StabilityLogEntry[] }).__scrollStabilityLog = stabilityLog;
  }
}

/**
 * The scroller must have browser scroll anchoring OFF, or this whole subsystem
 * is reasoning from a false premise.
 *
 * Everything here attributes an unexplained change in `scrollTop` to the reader,
 * on the grounds that we are the only other writer (prepend-anchor-core.ts).
 * With `overflow-anchor: auto` the engine becomes a second writer and
 * `planFrame`, `planTailFrame` and `forcedByClamp` all start quietly booking its
 * adjustments as user input.
 *
 * That premise is held up by ONE declaration — `[overflow-anchor:none]` on the
 * layer in chat/page.tsx — which for a long time was documented as coming from
 * base-ui. It does not; the installed package sets it nowhere. So it looked like
 * an unexplained utility class, and deleting it would have broken three
 * algorithms at once without a single error. Check the computed value instead of
 * trusting the class to still be there.
 *
 * Once per pane, on the frame the layer is first resolved.
 */
function assertUnanchored(layer: HTMLElement): void {
  if (checkedLayers.has(layer)) return;
  checkedLayers.add(layer);
  if (typeof window === 'undefined') return;
  const value = window.getComputedStyle(layer).overflowAnchor;
  if (scrollerIsUnanchored(value)) return;
  // Loud on purpose, and in production too: the symptom otherwise is a reading
  // position that drifts on some devices and not others, which is the most
  // expensive kind of bug this repo has.
  console.error(
    `[scroll-stability] the timeline layer has overflow-anchor: ${value}. It must be "none" — ` +
      'the prepend anchor and the timeline window both assume the browser never moves scrollTop ' +
      'on its own. Restore [overflow-anchor:none] on [data-scroll-stability-layer] in chat/page.tsx.'
  );
  log({
    t: Date.now(),
    kind: 'intent',
    reason: `overflow-anchor:${value}`,
    wanted: 0,
    applied: 0,
    deviation: 0,
    scrollTop: 0,
  });
}

/**
 * One controller per chat viewport. Both the prepend anchor and the timeline
 * window use it, so neither can cancel the other's native momentum scroll.
 */
export function useScrollStability(getViewport: () => HTMLElement | null): ScrollStability {
  const deviation = useRef(0);
  const compensated = useRef(0);
  // iOS can emit both Touch Events and Pointer Events for one finger, then
  // `pointercancel` when the gesture becomes a scroll while the touch itself is
  // still down. Track the two streams independently: one boolean cleared by
  // either cancel would let settlement write into the middle of that gesture.
  const touchActive = useRef(false);
  const activePointers = useRef(new Set<number>());
  const lastReaderIntentAt = useRef(Number.NEGATIVE_INFINITY);
  const lastReaderDelta = useRef(0);
  const lastScrollAt = useRef(Number.NEGATIVE_INFINITY);
  const scrollVersion = useRef(0);
  const quietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleRaf = useRef<number | null>(null);
  const boundaryRebaseQueued = useRef(false);
  const lastBlockedReaderDelta = useRef(0);
  const lastObservedTop = useRef(0);
  const touchY = useRef(new Map<number, number>());
  const pointerY = useRef(new Map<number, number>());
  // Programmatic scroll events are asynchronous. Match the exact event instead
  // of guessing with a fixed time window, which both misses a delayed event and
  // swallows a real gesture that starts inside that window.
  const programmaticMotion = useRef<ProgrammaticMotion | null>(null);
  const programmaticEvent = useRef(false);
  const programmaticEventVersion = useRef(0);
  const smoothQuietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const layerNode = useRef<HTMLElement | null>(null);
  const getLayer = useCallback((): HTMLElement | null => {
    // Looked up once per pane. Every correction reads this, and so does every
    // scroll event through contentHeight(); the node only changes when the pane
    // remounts, which detaches the old one.
    const cached = layerNode.current;
    if (cached?.isConnected) return cached;
    const found = getViewport()?.querySelector('[data-scroll-stability-layer]') as HTMLElement | null;
    layerNode.current = found;
    if (found) assertUnanchored(found);
    return found;
  }, [getViewport]);

  const paintDeviation = useCallback(() => {
    const layer = getLayer();
    if (!layer) return;
    const d = deviation.current;
    layer.style.transform = Math.abs(d) < 0.01 ? '' : `translateY(${-d}px)`;
    layer.style.willChange = Math.abs(d) < 0.01 ? '' : 'transform';
  }, [getLayer]);

  const markProgrammaticEvent = useCallback(() => {
    const version = ++programmaticEventVersion.current;
    programmaticEvent.current = true;
    queueMicrotask(() => {
      if (programmaticEventVersion.current === version) programmaticEvent.current = false;
    });
  }, []);

  const clearProgrammaticMotion = useCallback(() => {
    programmaticMotion.current = null;
    if (smoothQuietTimer.current !== null) clearTimeout(smoothQuietTimer.current);
    smoothQuietTimer.current = null;
  }, []);

  const hasActiveContact = useCallback(
    () => touchActive.current || activePointers.current.size > 0,
    [],
  );

  const isScrolling = useCallback((): boolean => {
    return hasActiveContact()
      || programmaticMotion.current?.kind === 'smooth'
      || performance.now() - lastScrollAt.current < SCROLL_QUIET_MS;
  }, [hasActiveContact]);

  const hasReaderIntent = useCallback((): boolean => {
    return hasActiveContact()
      || performance.now() - lastReaderIntentAt.current < SCROLL_QUIET_MS;
  }, [hasActiveContact]);

  const hasUpwardReaderIntent = useCallback((): boolean => {
    // Zero is deliberate: a scrollbar drag and a compositor scroll can move
    // before a directional touchmove reaches JavaScript. A known positive raw
    // direction, however, means a later negative scroll is WebKit bounce-back,
    // not a request to read history.
    return lastReaderDelta.current <= 0 && hasReaderIntent();
  }, [hasReaderIntent]);

  const hasBlockedUpwardIntent = useCallback((): boolean => {
    return lastBlockedReaderDelta.current < 0 && hasReaderIntent();
  }, [hasReaderIntent]);

  const commitDeviation = useCallback((reason: string): number => {
    const vp = getViewport();
    if (!vp) return 0;
    if (quietTimer.current !== null) clearTimeout(quietTimer.current);
    quietTimer.current = null;
    if (settleRaf.current !== null) cancelAnimationFrame(settleRaf.current);
    settleRaf.current = null;
    clearProgrammaticMotion();
    const wanted = deviation.current;
    if (Math.abs(wanted) < SETTLE_EPSILON) {
      // Do not keep a compositing layer alive forever for a fraction of a pixel.
      const normalized = discardSubpixelDeviation(
        deviation.current,
        compensated.current,
        SETTLE_EPSILON,
      );
      deviation.current = normalized.deviation;
      compensated.current = normalized.compensated;
      paintDeviation();
      return 0;
    }
    const before = vp.scrollTop;
    // The visible coordinate this settlement must preserve.
    const target = before + wanted;
    // Take the transform OFF before writing scrollTop. WebKit recomputes the
    // scroller's overflow only when the transform is added or removed, so a
    // write made underneath a live one is clamped into a range that stops
    // existing the instant we clear it — and the browser then re-clamps,
    // silently, by as much as the transform was worth. Clearing first makes the
    // write land in the range it will still be in afterwards. Both statements
    // are in one task, so nothing is painted in between.
    deviation.current = 0;
    paintDeviation();
    vp.scrollTop = target;
    const landed = vp.scrollTop;
    const applied = landed - before;
    // The range is honest now, so anything the clamp refused was blank space
    // the transform itself was inventing — there is no content there to settle
    // onto, and holding it would put the reader straight back outside the
    // conversation. Drop it, and take the same amount out of `compensated`, so
    // the reader-only coordinate (and any live hold reading it) does not see a
    // scroll nobody made. Measured: physical 3198 under a transform latched at
    // +100, cleared, browser silently re-clamps to 3098 — that 100px used to be
    // booked as the reader scrolling.
    const dropped = target - landed;
    deviation.current = 0;
    compensated.current -= dropped;
    // A clamped no-op dispatches no scroll event, so there is nothing to match.
    // Leaving an instant motion behind would misclassify the next real gesture.
    // Both writes above happen in this task, so the browser dispatches at most
    // one scroll event, carrying the final position.
    programmaticMotion.current = applied === 0
      ? null
      : { kind: 'instant', expectedTop: vp.scrollTop };
    lastObservedTop.current = vp.scrollTop;
    log({
      t: Date.now(), kind: 'settle', reason,
      wanted, applied, deviation: dropped, scrollTop: vp.scrollTop,
    });
    return applied;
  }, [clearProgrammaticMotion, getViewport, paintDeviation]);

  const settle = useCallback(() => {
    settleRaf.current = null;
    if (isScrolling()) return;
    commitDeviation('native-scroll-ended');
  }, [commitDeviation, isScrolling]);

  /** Content height read off the layer, where the held transform cannot reach. */
  const measureContent = useCallback((vp: HTMLElement): number => trueContentHeight({
    layerHeight: getLayer()?.offsetHeight ?? 0,
    scrollHeight: vp.scrollHeight,
    clientHeight: vp.clientHeight,
  }), [getLayer]);

  /** The far end of the range a correction may leave the visible coordinate in. */
  const honestMaxTop = useCallback((vp: HTMLElement): number => (
    Math.max(0, measureContent(vp) - vp.clientHeight)
  ), [measureContent]);

  const contentHeight = useCallback((): number => {
    const vp = getViewport();
    return vp ? measureContent(vp) : 0;
  }, [getViewport, measureContent]);

  const maxScrollTop = useCallback((): number => {
    const vp = getViewport();
    return vp ? honestMaxTop(vp) : 0;
  }, [getViewport, honestMaxTop]);

  const hasBlockedBoundary = useCallback((readerDelta: number): boolean => {
    const vp = getViewport();
    if (!vp) return false;
    return planBoundaryRebase({
      scrollTop: vp.scrollTop,
      deviation: deviation.current,
      // The browser's own max, transform inflation included: this asks whether
      // the PHYSICAL scroller has run out of runway, and the physical clamp is
      // computed from exactly this number. The honest content height belongs to
      // questions about where the reader is, not about where scrollTop can go.
      maxTop: Math.max(0, vp.scrollHeight - vp.clientHeight),
      minTop: 0,
      readerDelta,
      epsilon: SETTLE_EPSILON,
    }) !== null;
  }, [getViewport]);

  const rebaseBlockedBoundary = useCallback((readerDelta: number, reason: string): boolean => {
    if (!hasBlockedBoundary(readerDelta)) return false;
    commitDeviation(reason);
    return true;
  }, [commitDeviation, hasBlockedBoundary]);

  /**
   * Give back the part of a held deviation the reader has just scrolled past.
   *
   * A negative deviation paints content downward, which leaves the physical
   * scroller taller than the conversation: the reader keeps `scrollTop` runway
   * after `scrollTop + deviation` has already gone above the first row, and
   * scrolls up through space that does not exist. `planBoundaryRebase` cannot
   * help — a setter call has nowhere to put this one, which is exactly why it
   * returns null — so today the whole thing survives to `commitDeviation` and is
   * discarded in one frame once scrolling stops. Measured on a conversation that
   * loads its history when the reader reaches the top: a 245px jump (348px on a
   * second run) with the reader's hands already off the wheel.
   *
   * Hand it back a frame at a time instead. Same total, spread over the gesture
   * that is consuming it, and nothing is left to discard at the end.
   */
  const trimTopRunway = useCallback(() => {
    const vp = getViewport();
    if (!vp || deviation.current >= 0) return;
    const trim = trimOutOfRangeDeviation({
      scrollTop: vp.scrollTop,
      deviation: deviation.current,
      minTop: 0,
    });
    if (trim === 0) return;
    deviation.current += trim;
    // `commitDeviation` books a discarded correction the same way: the reader
    // did not make this movement, so it must not show up in `readerScrollTop`.
    compensated.current += trim;
    paintDeviation();
    log({
      t: Date.now(), kind: 'settle', reason: 'top-runway-trim',
      wanted: trim, applied: trim, deviation: deviation.current, scrollTop: vp.scrollTop,
    });
  }, [getViewport, paintDeviation]);

  const queueBoundaryRebase = useCallback((readerDelta: number, reason: string) => {
    // Ordinary scroll events should pay no microtask tax. Queue only for the
    // rare frame that actually exhausted a transform-held physical runway.
    if (!hasBlockedBoundary(readerDelta)) return;
    // Keep the raw fact separate from geometry. WebKit may run a microtask
    // between two listeners for one trusted input event, so the page cannot
    // reliably inspect scrollTop/deviation after this listener and expect the
    // pre-rebase values still to be there.
    lastBlockedReaderDelta.current = readerDelta;
    if (boundaryRebaseQueued.current) return;
    boundaryRebaseQueued.current = true;
    // Keep the atomic swap outside this callback. The explicit blocked-intent
    // latch above is what lets later listeners make decisions about this input.
    queueMicrotask(() => {
      boundaryRebaseQueued.current = false;
      rebaseBlockedBoundary(readerDelta, reason);
    });
  }, [hasBlockedBoundary, rebaseBlockedBoundary]);

  const scheduleSettle = useCallback(() => {
    if (quietTimer.current !== null) clearTimeout(quietTimer.current);
    if (settleRaf.current !== null) {
      cancelAnimationFrame(settleRaf.current);
      settleRaf.current = null;
    }
    const arm = () => {
      const wait = hasActiveContact()
        ? SCROLL_QUIET_MS
        : Math.max(0, SCROLL_QUIET_MS - (performance.now() - lastScrollAt.current));
      quietTimer.current = setTimeout(() => {
        quietTimer.current = null;
        if (isScrolling()) {
          arm();
          return;
        }
        // Two quiet animation frames reject a late momentum event that arrived
        // at the edge of the timer without polling during the gesture itself.
        const version = scrollVersion.current;
        settleRaf.current = requestAnimationFrame(() => {
          settleRaf.current = requestAnimationFrame(() => {
            if (hasActiveContact() || version !== scrollVersion.current) {
              settleRaf.current = null;
              arm();
              return;
            }
            settle();
          });
        });
      }, wait);
    };
    arm();
  }, [hasActiveContact, isScrolling, settle]);

  const compensate = useCallback((delta: number, reason: string, bounded = false): number => {
    if (!Number.isFinite(delta) || delta === 0) return 0;
    const vp = getViewport();
    // Corrections used to be `scrollTop` writes, which the browser clamped at
    // both ends while the caller adopted the shortfall — that clamp is what
    // kept the loop from running away. A transform has no ends, so apply the
    // same limit here, or a single bad measurement is painted in full — and,
    // through the overflow it adds, becomes an input to the next one.
    const accepted = bounded && vp
      ? acceptableCompensation({
        scrollTop: vp.scrollTop,
        deviation: deviation.current,
        delta,
        minTop: 0,
        maxTop: honestMaxTop(vp),
      })
      : delta;
    if (accepted !== 0) {
      deviation.current += accepted;
      compensated.current += accepted;
      paintDeviation();
    }
    // Log the refusals too, and log what was actually taken rather than a
    // hardcoded zero: a correction the range check threw away is precisely the
    // frame someone reading this log after an unexplained jump needs to see.
    log({
      t: Date.now(), kind: 'hold', reason, wanted: delta, applied: accepted,
      deviation: deviation.current, scrollTop: vp?.scrollTop ?? 0,
    });
    // Even a fully refused correction has to leave the settle armed: whatever is
    // already held still needs writing back, and this call used to arm it.
    scheduleSettle();
    // The transform is neither clamped nor quantised, so whatever survived the
    // range check above landed in full even though scrollTop did not move.
    return accepted;
  }, [getViewport, honestMaxTop, paintDeviation, scheduleSettle]);

  const scrollTo = useCallback((top: number, behavior: ScrollBehavior, reason: string): number => {
    const vp = getViewport();
    if (!vp || !Number.isFinite(top)) return 0;
    if (quietTimer.current !== null) clearTimeout(quietTimer.current);
    quietTimer.current = null;
    if (settleRaf.current !== null) cancelAnimationFrame(settleRaf.current);
    settleRaf.current = null;
    clearProgrammaticMotion();

    const heldDeviation = deviation.current;
    // This navigation now owns the viewport. Removing the transform before the
    // write prevents a sticky-bottom jump from applying the same geometry change
    // once physically and once visually.
    deviation.current = 0;
    // `compensated` is the reader-coordinate origin used by a live prepend
    // hold. Keep it: the physical navigation below must appear to that hold as
    // exactly the distance navigated, without an extra jump from rebasing the
    // coordinate system underneath it.
    paintDeviation();
    const before = vp.scrollTop;
    // A held transform is part of the current visual coordinate. WebKit starts
    // a smooth scroll asynchronously, so clearing that transform and waiting
    // for the first animation tick would expose one displaced frame. An intent
    // that takes over such a correction therefore lands atomically.
    const effectiveBehavior = behavior === 'smooth' && heldDeviation === 0 ? 'smooth' : 'auto';
    if (effectiveBehavior === 'smooth') {
      programmaticMotion.current = { kind: 'smooth', lastTop: before };
      smoothQuietTimer.current = setTimeout(clearProgrammaticMotion, SCROLL_QUIET_MS);
      vp.scrollTo({ top, behavior: effectiveBehavior });
    } else {
      programmaticMotion.current = { kind: 'instant', expectedTop: top };
      vp.scrollTop = top;
      programmaticMotion.current = { kind: 'instant', expectedTop: vp.scrollTop };
    }
    const applied = vp.scrollTop - before;
    log({
      t: Date.now(), kind: 'intent', reason,
      wanted: top - before, applied, deviation: 0, scrollTop: vp.scrollTop,
    });
    return applied;
  }, [clearProgrammaticMotion, getViewport, paintDeviation]);

  const logicalScrollTop = useCallback((): number => {
    const vp = getViewport();
    return logicalTop(vp?.scrollTop ?? 0, deviation.current);
  }, [getViewport]);

  const scrollBy = useCallback((delta: number, behavior: ScrollBehavior, reason: string): number => {
    if (!Number.isFinite(delta) || delta === 0) return 0;
    return scrollTo(logicalScrollTop() + delta, behavior, reason);
  }, [logicalScrollTop, scrollTo]);

  const getDeviation = useCallback(() => deviation.current, []);
  const isProgrammatic = useCallback(
    () => programmaticEvent.current || programmaticMotion.current?.kind === 'smooth',
    [],
  );
  const readerScrollTop = useCallback((): number => {
    const vp = getViewport();
    return readerTop(vp?.scrollTop ?? 0, deviation.current, compensated.current);
  }, [getViewport]);

  useEffect(() => {
    const vp = getViewport();
    if (!vp) return;
    const activePointersAtMount = activePointers.current;
    const touchYAtMount = touchY.current;
    const pointerYAtMount = pointerY.current;
    lastObservedTop.current = vp.scrollTop;
    const noteScroll = () => {
      const physicalDelta = vp.scrollTop - lastObservedTop.current;
      lastObservedTop.current = vp.scrollTop;
      const motion = programmaticMotion.current;
      if (motion?.kind === 'instant') {
        if (Math.abs(vp.scrollTop - motion.expectedTop) < SETTLE_EPSILON) {
          programmaticMotion.current = null;
          markProgrammaticEvent();
          return;
        }
        programmaticMotion.current = null;
      } else if (motion?.kind === 'smooth') {
        motion.lastTop = vp.scrollTop;
        lastScrollAt.current = performance.now();
        scrollVersion.current += 1;
        markProgrammaticEvent();
        if (smoothQuietTimer.current !== null) clearTimeout(smoothQuietTimer.current);
        smoothQuietTimer.current = setTimeout(clearProgrammaticMotion, SCROLL_QUIET_MS);
        if (deviation.current !== 0) scheduleSettle();
        return;
      }
      lastScrollAt.current = performance.now();
      scrollVersion.current += 1;
      // Before anything else: a deviation the reader has already scrolled past
      // is not a correction owed to them, it is a debt to settle that no setter
      // can pay. Take it off here and the `scheduleSettle` below has nothing to
      // dump when the gesture ends.
      trimTopRunway();
      if (deviation.current !== 0) scheduleSettle();
      if (physicalDelta !== 0) {
        queueBoundaryRebase(physicalDelta, 'native-boundary-runway');
      }
    };
    const press = () => {
      clearProgrammaticMotion();
      lastReaderIntentAt.current = performance.now();
      scrollVersion.current += 1;
      if (deviation.current !== 0) scheduleSettle();
    };
    const release = () => {
      if (!hasActiveContact() && deviation.current !== 0) scheduleSettle();
    };
    const touchStart = (event: TouchEvent) => {
      touchActive.current = event.touches.length > 0;
      lastReaderDelta.current = 0;
      lastBlockedReaderDelta.current = 0;
      touchY.current.clear();
      for (const touch of Array.from(event.touches)) {
        touchY.current.set(touch.identifier, touch.clientY);
      }
      press();
    };
    const touchRelease = (event: TouchEvent) => {
      touchActive.current = event.touches.length > 0;
      touchY.current.clear();
      for (const touch of Array.from(event.touches)) {
        touchY.current.set(touch.identifier, touch.clientY);
      }
      release();
    };
    const pointerDown = (event: PointerEvent) => {
      activePointers.current.add(event.pointerId);
      pointerY.current.set(event.pointerId, event.clientY);
      lastReaderDelta.current = 0;
      lastBlockedReaderDelta.current = 0;
      press();
    };
    const pointerMove = (event: PointerEvent) => {
      lastBlockedReaderDelta.current = 0;
      const before = pointerY.current.get(event.pointerId);
      pointerY.current.set(event.pointerId, event.clientY);
      if (before === undefined || event.pointerType === 'mouse') return;
      lastReaderDelta.current = before - event.clientY;
      queueBoundaryRebase(lastReaderDelta.current, 'pointer-boundary-runway');
      lastReaderIntentAt.current = performance.now();
    };
    const pointerRelease = (event: PointerEvent) => {
      activePointers.current.delete(event.pointerId);
      pointerY.current.delete(event.pointerId);
      release();
    };
    const abandonContacts = () => {
      touchActive.current = false;
      activePointers.current.clear();
      touchY.current.clear();
      pointerY.current.clear();
      release();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') abandonContacts();
    };
    const wheel = (event: WheelEvent) => {
      lastBlockedReaderDelta.current = 0;
      // Pinch zoom arrives as Ctrl+wheel, and a horizontal trackpad swipe can
      // carry a small incidental deltaY. Neither is a request for timeline
      // runway, so do not settle a held transform for it.
      if (!isVerticalWheelInput(event.deltaX, event.deltaY, event.ctrlKey)) return;
      clearProgrammaticMotion();
      lastReaderIntentAt.current = performance.now();
      lastScrollAt.current = performance.now();
      scrollVersion.current += 1;
      lastReaderDelta.current = event.deltaY;
      queueBoundaryRebase(event.deltaY, 'wheel-boundary-runway');
      if (deviation.current !== 0) scheduleSettle();
    };
    const touchMove = (event: TouchEvent) => {
      lastBlockedReaderDelta.current = 0;
      lastReaderIntentAt.current = performance.now();
      for (const touch of Array.from(event.touches)) {
        const before = touchY.current.get(touch.identifier);
        touchY.current.set(touch.identifier, touch.clientY);
        if (before !== undefined) {
          // Finger down moves the viewport toward older content, hence the
          // inverse sign in scrollTop coordinates.
          lastReaderDelta.current = before - touch.clientY;
          queueBoundaryRebase(lastReaderDelta.current, 'touch-boundary-runway');
        }
      }
    };
    vp.addEventListener('scroll', noteScroll, { passive: true });
    vp.addEventListener('wheel', wheel, { passive: true });
    vp.addEventListener('touchstart', touchStart, { passive: true });
    vp.addEventListener('touchmove', touchMove, { passive: true });
    vp.addEventListener('pointerdown', pointerDown, { passive: true });
    vp.addEventListener('pointermove', pointerMove, { passive: true });
    // End events are deliberately global. A pointer can be released outside the
    // viewport, and a touched row can be unmounted by windowing before touchend.
    // Keeping these on the viewport would leave contact state stuck forever.
    window.addEventListener('touchend', touchRelease, { passive: true });
    window.addEventListener('touchcancel', touchRelease, { passive: true });
    window.addEventListener('pointerup', pointerRelease, { passive: true });
    window.addEventListener('pointercancel', pointerRelease, { passive: true });
    window.addEventListener('blur', abandonContacts);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      vp.removeEventListener('scroll', noteScroll);
      vp.removeEventListener('wheel', wheel);
      vp.removeEventListener('touchstart', touchStart);
      vp.removeEventListener('touchmove', touchMove);
      vp.removeEventListener('pointerdown', pointerDown);
      vp.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('touchend', touchRelease);
      window.removeEventListener('touchcancel', touchRelease);
      window.removeEventListener('pointerup', pointerRelease);
      window.removeEventListener('pointercancel', pointerRelease);
      window.removeEventListener('blur', abandonContacts);
      document.removeEventListener('visibilitychange', visibilityChanged);
      touchActive.current = false;
      activePointersAtMount.clear();
      touchYAtMount.clear();
      pointerYAtMount.clear();
    };
  }, [
    clearProgrammaticMotion, getViewport, hasActiveContact, markProgrammaticEvent,
    queueBoundaryRebase, scheduleSettle, trimTopRunway,
  ]);

  // A clamped settlement deliberately leaves its unpaid part in the transform.
  // When content later makes the scroll range larger, retry it without requiring
  // another compensation or reader gesture to wake the controller.
  useEffect(() => {
    const layer = getLayer();
    if (!layer || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (deviation.current !== 0) scheduleSettle();
    });
    ro.observe(layer);
    return () => ro.disconnect();
  }, [getLayer, scheduleSettle]);

  useEffect(() => () => {
    if (quietTimer.current !== null) clearTimeout(quietTimer.current);
    if (settleRaf.current !== null) cancelAnimationFrame(settleRaf.current);
    clearProgrammaticMotion();
    const layer = getLayer();
    if (layer) {
      layer.style.transform = '';
      layer.style.willChange = '';
    }
  }, [clearProgrammaticMotion, getLayer]);

  return useMemo(
    () => ({
      compensate, logicalScrollTop, contentHeight, maxScrollTop, readerScrollTop,
      scrollTo, scrollBy,
      getDeviation, isScrolling, hasReaderIntent, hasUpwardReaderIntent,
      hasBlockedUpwardIntent, isProgrammatic,
    }),
    [
      compensate, logicalScrollTop, contentHeight, maxScrollTop, readerScrollTop,
      scrollTo, scrollBy,
      getDeviation, isScrolling, hasReaderIntent, hasUpwardReaderIntent,
      hasBlockedUpwardIntent, isProgrammatic,
    ],
  );
}
