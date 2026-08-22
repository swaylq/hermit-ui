'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  discardSubpixelDeviation,
  logicalScrollTop as logicalTop,
  readerScrollTop as readerTop,
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
   */
  compensate: (delta: number, reason: string) => number;
  /** Natural timeline coordinate currently at the viewport top. */
  logicalScrollTop: () => number;
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
function log(entry: StabilityLogEntry): void {
  stabilityLog.push(entry);
  if (stabilityLog.length > LOG_SIZE) stabilityLog.shift();
  if (typeof window !== 'undefined') {
    (window as unknown as { __scrollStabilityLog?: StabilityLogEntry[] }).__scrollStabilityLog = stabilityLog;
  }
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
  const lastScrollAt = useRef(Number.NEGATIVE_INFINITY);
  const scrollVersion = useRef(0);
  const quietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleRaf = useRef<number | null>(null);
  // Programmatic scroll events are asynchronous. Match the exact event instead
  // of guessing with a fixed time window, which both misses a delayed event and
  // swallows a real gesture that starts inside that window.
  const programmaticMotion = useRef<ProgrammaticMotion | null>(null);
  const programmaticEvent = useRef(false);
  const programmaticEventVersion = useRef(0);
  const smoothQuietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getLayer = useCallback((): HTMLElement | null => {
    return getViewport()?.querySelector('[data-scroll-stability-layer]') as HTMLElement | null;
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

  const settle = useCallback(() => {
    settleRaf.current = null;
    const vp = getViewport();
    if (!vp || isScrolling()) return;
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
      return;
    }
    const before = vp.scrollTop;
    programmaticMotion.current = { kind: 'instant', expectedTop: before + wanted };
    vp.scrollTop = before + wanted;
    const applied = vp.scrollTop - before;
    deviation.current -= applied;
    const normalized = discardSubpixelDeviation(
      deviation.current,
      compensated.current,
      SETTLE_EPSILON,
    );
    deviation.current = normalized.deviation;
    compensated.current = normalized.compensated;
    programmaticMotion.current = { kind: 'instant', expectedTop: vp.scrollTop };
    paintDeviation();
    log({
      t: Date.now(), kind: 'settle', reason: 'native-scroll-ended',
      wanted, applied, deviation: deviation.current, scrollTop: vp.scrollTop,
    });
  }, [getViewport, isScrolling, paintDeviation]);

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

  const compensate = useCallback((delta: number, reason: string): number => {
    if (!Number.isFinite(delta) || delta === 0) return 0;
    deviation.current += delta;
    compensated.current += delta;
    paintDeviation();
    const vp = getViewport();
    log({
      t: Date.now(), kind: 'hold', reason, wanted: delta, applied: 0,
      deviation: deviation.current, scrollTop: vp?.scrollTop ?? 0,
    });
    scheduleSettle();
    // The transform is not clamped or quantised, so the whole visual correction
    // landed even though scrollTop deliberately did not move.
    return delta;
  }, [getViewport, paintDeviation, scheduleSettle]);

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
    const noteScroll = () => {
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
      if (deviation.current !== 0) scheduleSettle();
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
      press();
    };
    const touchRelease = (event: TouchEvent) => {
      touchActive.current = event.touches.length > 0;
      release();
    };
    const pointerDown = (event: PointerEvent) => {
      activePointers.current.add(event.pointerId);
      press();
    };
    const pointerRelease = (event: PointerEvent) => {
      activePointers.current.delete(event.pointerId);
      release();
    };
    const abandonContacts = () => {
      touchActive.current = false;
      activePointers.current.clear();
      release();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') abandonContacts();
    };
    const wheel = () => {
      clearProgrammaticMotion();
      lastReaderIntentAt.current = performance.now();
      lastScrollAt.current = performance.now();
      scrollVersion.current += 1;
      if (deviation.current !== 0) scheduleSettle();
    };
    const touchMove = () => {
      lastReaderIntentAt.current = performance.now();
    };
    vp.addEventListener('scroll', noteScroll, { passive: true });
    vp.addEventListener('wheel', wheel, { passive: true });
    vp.addEventListener('touchstart', touchStart, { passive: true });
    vp.addEventListener('touchmove', touchMove, { passive: true });
    vp.addEventListener('pointerdown', pointerDown, { passive: true });
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
      window.removeEventListener('touchend', touchRelease);
      window.removeEventListener('touchcancel', touchRelease);
      window.removeEventListener('pointerup', pointerRelease);
      window.removeEventListener('pointercancel', pointerRelease);
      window.removeEventListener('blur', abandonContacts);
      document.removeEventListener('visibilitychange', visibilityChanged);
      touchActive.current = false;
      activePointers.current.clear();
    };
  }, [clearProgrammaticMotion, getViewport, hasActiveContact, markProgrammaticEvent, scheduleSettle]);

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
      compensate, logicalScrollTop, readerScrollTop, scrollTo, scrollBy,
      getDeviation, isScrolling, hasReaderIntent, isProgrammatic,
    }),
    [
      compensate, logicalScrollTop, readerScrollTop, scrollTo, scrollBy,
      getDeviation, isScrolling, hasReaderIntent, isProgrammatic,
    ],
  );
}
