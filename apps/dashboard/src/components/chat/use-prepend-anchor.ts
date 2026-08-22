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
//
// There are two things a reader can be looking at when a prepend lands: a
// message near the top (they scrolled up to read history), or the TAIL (they
// are pinned to the bottom while a prefill thickens a short conversation).
// `capture` decides which, and the hold keeps that one steady — the top anchor
// via `planFrame`, the bottom anchor via `planBottomFrame`.
//
// The settle window here is not a fixed 1500ms from `capture()` any more. That
// is what broke on the phone: the page was fetched and 120 rows parsed, and by
// the time the first correction was due the deadline had already passed, so the
// displaced frame painted uncorrected. Now the deadline is RE-ARMED after each
// committed chunk and after each content resize (see `rearm`), with a hard cap
// measured from `capture()`. A live streaming tail keeps resizing the content,
// and without the cap the hold would never end.

import { useCallback, useEffect, useRef } from 'react';
import { planFrame, planBottomFrame, type AnchorHold, type BottomHold } from './prepend-anchor-core';

// How long after the LAST activity (a chunk commit, or a content resize) we keep
// correcting. Short enough that once the content is truly quiet we let go; long
// enough to outlast a markdown + highlight + image pass on a slow phone.
const SETTLE_MS = 1500;
// Hard cap on one hold, measured from `capture()`. Covers a stream that keeps
// resizing the content (each resize would otherwise re-arm forever).
const MAX_HOLD_MS = 3000;
// Below this distance from the bottom the reader counts as "pinned to the end",
// so a prepend holds the tail rather than the top row. Matches the ~60px slack
// the pin detector in chat/page.tsx uses.
const BOTTOM_SLACK = 60;

type Held =
  | { mode: 'top'; id: string; hold: AnchorHold; until: number; maxUntil: number }
  | { mode: 'bottom'; hold: BottomHold; until: number; maxUntil: number };

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
  /** Extend the settle window — called after each chunk lands and on content
   *  resize, so the deadline never expires before the work it guards has run. */
  rearm: (ms?: number) => void;
  /** True while a captured anchor is still being held steady. */
  isHolding: () => boolean;
  /** Abandon the anchor entirely. */
  release: () => void;
};

export function usePrependAnchor(getViewport: () => HTMLElement | null): PrependAnchor {
  const held = useRef<Held | null>(null);
  const raf = useRef<number | null>(null);
  const ro = useRef<ResizeObserver | null>(null);

  const release = useCallback(() => {
    held.current = null;
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    ro.current?.disconnect();
    ro.current = null;
  }, []);

  const rearm = useCallback((ms: number = SETTLE_MS) => {
    const h = held.current;
    if (!h) return;
    h.until = Math.min(Date.now() + ms, h.maxUntil);
  }, []);

  const reassert = useCallback(() => {
    const h = held.current;
    if (!h) return;
    if (Date.now() > h.maxUntil || Date.now() > h.until) {
      release();
      return;
    }
    const root = getViewport();
    if (!root) return;

    if (h.mode === 'bottom') {
      const { correction, gap } = planBottomFrame(h.hold, {
        scrollTop: root.scrollTop,
        scrollHeight: root.scrollHeight,
        clientHeight: root.clientHeight,
      });
      h.hold.gap = gap;
      if (correction !== 0) root.scrollTop += correction;
      h.hold.lastTop = root.scrollTop;
      return;
    }

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
  }, [getViewport, release]);

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
    const until = Date.now() + SETTLE_MS;
    const maxUntil = Date.now() + MAX_HOLD_MS;
    let captured = false;

    // Pinned to the bottom → hold the TAIL, so a prefill prepends history above
    // and leaves the last messages where they were instead of jumping the view
    // to the top of what just arrived.
    if (root.scrollHeight - root.scrollTop - root.clientHeight < BOTTOM_SLACK) {
      held.current = {
        mode: 'bottom',
        hold: { gap: root.scrollHeight - root.scrollTop - root.clientHeight, lastTop: root.scrollTop },
        until,
        maxUntil,
      };
      captured = true;
    } else {
      const vpTop = root.getBoundingClientRect().top;
      // The topmost message still visible: the first whose bottom edge has not
      // passed the top of the viewport. That's what the user is reading.
      for (const el of Array.from(root.querySelectorAll('[data-msg-id]'))) {
        const r = el.getBoundingClientRect();
        if (r.bottom > vpTop) {
          const id = (el.getAttribute('data-msg-id') ?? '').split(' ')[0];
          if (id) {
            held.current = {
              mode: 'top',
              id,
              hold: { offset: r.top - vpTop, lastTop: root.scrollTop },
              until,
              maxUntil,
            };
            captured = true;
          }
          break;
        }
      }
    }

    if (captured) {
      pump();
      // Observe the content box so a resize that lands AFTER the quiet window
      // (an image getting its intrinsic size, a font swap) re-arms the hold and
      // is caught instead of shoving the text once we've let go.
      const content = root.firstElementChild as HTMLElement | null;
      ro.current?.disconnect();
      if (content && typeof ResizeObserver !== 'undefined') {
        const obs = new ResizeObserver(() => {
          if (held.current) rearm();
        });
        obs.observe(content);
        ro.current = obs;
      }
    }
  }, [getViewport, pump, rearm]);

  const isHolding = useCallback(() => held.current !== null, []);

  useEffect(
    () => () => {
      release();
    },
    [release]
  );

  return { capture, reassert, rearm, isHolding, release };
}
