'use client';

// Keeps the reading position still while history is prepended above it.
//
// The old restore was a single measurement: remember scrollHeight/scrollTop
// before the prepend, then in a layout effect set
// `scrollTop = scrollHeight - oldHeight + oldTop`. That is correct only if the
// prepended content has its final height by the time the layout effect runs —
// and it never does. 200 messages of markdown parse, code blocks get
// highlighted, images resolve their intrinsic size, and each of those grows the
// content ABOVE the viewport after the fact. The result is the jump: the view
// lands roughly right, then slides as the content settles.
//
// So anchor to an ELEMENT instead of to a height, and hold it. We record which
// message was at the top of the viewport and how far into it we were, then
// re-assert that exact offset on every layout change for a settle window. Any
// amount of asynchronous growth above the anchor is absorbed.

import { useCallback, useEffect, useRef } from 'react';

// How long to keep correcting after a prepend. Long enough to outlast markdown
// + highlight + image layout, short enough that a later genuine scroll is the
// user's own.
const SETTLE_MS = 1500;
// Sub-pixel corrections are invisible and only risk fighting the browser's own
// rounding, so ignore anything smaller.
const EPSILON = 0.5;
// Minimum spacing between re-anchors driven by user scrolling.
const FOLLOW_THROTTLE_MS = 120;

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
  /**
   * The user scrolled of their own accord. The anchor exists to absorb layout
   * growth, never to override input — so move the anchor to wherever they are
   * now and keep absorbing from there, rather than dragging them back.
   */
  followUser: () => void;
  /** Abandon the anchor entirely. */
  release: () => void;
};

export function usePrependAnchor(
  getViewport: () => HTMLElement | null,
  markAutoScroll: () => void
): PrependAnchor {
  const held = useRef<{ id: string; offset: number; until: number } | null>(null);
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
    const delta = el.getBoundingClientRect().top - root.getBoundingClientRect().top - h.offset;
    if (Math.abs(delta) < EPSILON) return;
    markAutoScroll(); // our correction must not read as the user scrolling away
    root.scrollTop += delta;
  }, [getViewport, markAutoScroll]);

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
          held.current = { id, offset: r.top - vpTop, until: Date.now() + SETTLE_MS };
          pump();
        }
        return;
      }
    }
  }, [getViewport, pump]);

  // Re-anchoring walks the message elements, so throttle it: a wheel gesture
  // fires far faster than layout actually needs correcting.
  const lastFollow = useRef(0);
  const followUser = useCallback(() => {
    if (!held.current) return;
    const now = Date.now();
    if (now - lastFollow.current < FOLLOW_THROTTLE_MS) return;
    lastFollow.current = now;
    const until = held.current.until;
    capture();
    // Keep the ORIGINAL deadline: following the user shouldn't extend how long
    // we stay attached to their scrolling.
    if (held.current) held.current.until = until;
  }, [capture]);

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

  return { capture, reassert, followUser, isHolding, release };
}
