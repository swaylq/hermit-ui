'use client';

// Keeps the reading position still while history is prepended above it.
//
// The first restore was a single measurement: remember scrollHeight/scrollTop
// before the prepend, then in a layout effect set
// `scrollTop = scrollHeight - oldHeight + oldTop`. That is correct only if the
// prepended content has its final height by the time the layout effect runs —
// and it never does. Markdown parses, code blocks get highlighted, images
// resolve their intrinsic size, and each of those grows the content ABOVE the
// viewport after the fact. The result is the jump: the view lands roughly
// right, then slides as the content settles.
//
// So anchor to an ELEMENT instead of to a height, and hold it: record which
// message was at the top of the viewport and how far into it we were, then
// re-assert that exact offset every frame for a settle window. Any amount of
// asynchronous growth above the anchor is absorbed.
//
// Holding it, though, is only half the job. Correcting by the anchor row's
// total displacement also undoes the user's own scrolling — see
// prepend-anchor-core.ts, which separates the two and is where the rule lives.

import { useCallback, useEffect, useRef } from 'react';
import { planFrame, type AnchorHold } from './prepend-anchor-core';

// How long to keep correcting after a prepend. Long enough to outlast markdown
// + highlight + image layout, short enough that a later genuine scroll is the
// user's own.
const SETTLE_MS = 1500;

export type PrependAnchor = {
  /** Record the current reading position. Call BEFORE triggering a prepend. */
  capture: () => void;
  /**
   * Re-apply the anchor NOW. Call from a layout effect keyed on the prepended
   * row count: that runs after the DOM mutation but before the browser paints,
   * so the displaced frame is never shown. The rAF loop below only cleans up
   * what settles later (markdown, highlighting, images) — on its own it is a
   * frame too late, and when the prepend is large enough to block the main
   * thread it can be many frames too late.
   */
  reassert: () => void;
  /** True while a captured anchor is still being held steady. */
  isHolding: () => boolean;
  /** Abandon the anchor entirely. */
  release: () => void;
};

export function usePrependAnchor(getViewport: () => HTMLElement | null): PrependAnchor {
  const held = useRef<{ id: string; hold: AnchorHold; until: number } | null>(null);
  const raf = useRef<number | null>(null);

  const reassert = useCallback(() => {
    const h = held.current;
    if (!h) return;
    if (Date.now() > h.until) {
      held.current = null;
      return;
    }
    const root = getViewport();
    if (!root) return;
    const el = root.querySelector(`[data-msg-id~="${CSS.escape(h.id)}"]`) as HTMLElement | null;
    if (!el) return;
    const anchorTop = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
    const { correction, offset } = planFrame(h.hold, { scrollTop: root.scrollTop, anchorTop });
    h.hold.offset = offset;
    if (correction !== 0) root.scrollTop += correction;
    // Read the position back instead of predicting it: the browser clamps at
    // both ends, and a predicted value that never happened would read as a user
    // scroll on the next frame and shift the anchor by the difference.
    h.hold.lastTop = root.scrollTop;
  }, [getViewport]);

  // A ResizeObserver only fires when the observed box changes. An image decoding
  // inside an already-sized row, a font swap, a code block gaining a scrollbar —
  // all shift content without necessarily resizing the container. So correct on
  // every frame of the settle window rather than trusting one signal.
  const pump = useCallback(() => {
    if (raf.current !== null) return; // already running
    const step = () => {
      reassert();
      if (held.current) raf.current = requestAnimationFrame(step);
      else raf.current = null;
    };
    raf.current = requestAnimationFrame(step);
  }, [reassert]);

  const capture = useCallback(() => {
    const root = getViewport();
    if (!root) return;
    const vpTop = root.getBoundingClientRect().top;
    // The topmost message still visible: the first whose bottom edge has not
    // passed the top of the viewport. That's what the user is reading.
    for (const el of Array.from(root.querySelectorAll('[data-msg-id]'))) {
      const r = el.getBoundingClientRect();
      if (r.bottom > vpTop) {
        const id = (el.getAttribute('data-msg-id') ?? '').split(' ')[0];
        if (id) {
          held.current = {
            id,
            hold: { offset: r.top - vpTop, lastTop: root.scrollTop },
            until: Date.now() + SETTLE_MS,
          };
          pump();
        }
        return;
      }
    }
  }, [getViewport, pump]);

  const release = useCallback(() => {
    held.current = null;
  }, []);

  const isHolding = useCallback(() => held.current !== null, []);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    []
  );

  return { capture, reassert, isHolding, release };
}
