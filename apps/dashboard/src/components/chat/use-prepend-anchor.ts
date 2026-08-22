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
import {
  planFrame,
  planBottomFrame,
  settledHold,
  shouldRecapture,
  type AnchorHold,
  type BottomHold,
} from './prepend-anchor-core';
import type { ScrollStability } from './use-scroll-stability';

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
// Consecutive frames with nothing to correct that put the rAF pump to sleep.
// The hold stays armed — the ResizeObserver on the content box wakes it the
// moment anything moves, and so does each committed chunk via `rearm`.
//
// Two reasons not to just run it for the whole window. A frame of the pump is a
// `querySelector` plus a `getBoundingClientRect`, i.e. a forced layout of a
// scroller that can be 40,000px tall, every frame for up to three seconds. And
// a frame that finds a correction WRITES `scrollTop`, which on iOS is
// `setContentOffset` and ends the reader's momentum scroll (see EPSILON in
// prepend-anchor-core.ts). Sleeping while the content is quiet costs nothing and
// removes both.
const QUIET_FRAMES = 6;

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
  /** Returns true when a live anchor found its geometry and owns this change. */
  reassert: () => boolean;
  /** Extend the settle window — called after each chunk lands and on content
   *  resize, so the deadline never expires before the work it guards has run. */
  rearm: (ms?: number) => void;
  /** True while a captured anchor is still being held steady. */
  isHolding: () => boolean;
  /** Abandon the anchor entirely. */
  release: () => void;
};

/**
 * The last few hundred corrections, for a jump nobody can reproduce on demand.
 *
 * This one is intermittent by nature: on a warm cache a page of history arrives
 * inside the frame that asked for it, so whether the correction lands cleanly
 * depends on how a handful of events interleave. It has been caught once with
 * full frame data — content grew 2,481px, `scrollTop` moved 1,972px, the reader
 * lost 509px — and not again in twenty attempts across both modes, both cache
 * states, and five viewport sizes. A description after the fact cannot tell us
 * which frame went wrong, so record it while it happens.
 *
 * Bounded, allocation-free after warmup, and only written on frames that
 * actually corrected something. Dump it from the console right after a jump:
 *   copy(JSON.stringify(window.__prependAnchorLog))
 */
const LOG_SIZE = 300;
type AnchorLogEntry = {
  t: number;
  mode: 'top' | 'bottom' | 'lost';
  /** What this frame asked for, before the browser clamped or quantised it. */
  raw: number;
  /** What `scrollTop` actually moved by. A gap here is a correction that could not land. */
  applied: number;
  scrollTop: number;
  scrollHeight: number;
};
const anchorLog: AnchorLogEntry[] = [];
function logCorrection(e: AnchorLogEntry): void {
  anchorLog.push(e);
  if (anchorLog.length > LOG_SIZE) anchorLog.shift();
  if (typeof window !== 'undefined') {
    (window as unknown as { __prependAnchorLog?: AnchorLogEntry[] }).__prependAnchorLog = anchorLog;
  }
}

export function usePrependAnchor(
  getViewport: () => HTMLElement | null,
  stability: ScrollStability,
): PrependAnchor {
  const held = useRef<Held | null>(null);
  const raf = useRef<number | null>(null);
  const ro = useRef<ResizeObserver | null>(null);
  /** Consecutive frames the pump found nothing to do — see QUIET_FRAMES. */
  const quiet = useRef(0);

  const release = useCallback(() => {
    held.current = null;
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    ro.current?.disconnect();
    ro.current = null;
  }, []);

  const reassert = useCallback(() => {
    const h = held.current;
    if (!h) return false;
    if (Date.now() > h.maxUntil || Date.now() > h.until) {
      release();
      return false;
    }
    const root = getViewport();
    if (!root) return false;

    if (h.mode === 'bottom') {
      const logicalTop = stability.logicalScrollTop();
      const { correction, gap, raw } = planBottomFrame(h.hold, {
        scrollTop: logicalTop,
        userScrollTop: stability.readerScrollTop(),
        scrollHeight: root.scrollHeight,
        clientHeight: root.clientHeight,
      });
      const applied = correction !== 0 ? stability.compensate(correction, 'prepend-bottom') : 0;
      h.hold.gap = settledHold(gap, raw, applied);
      h.hold.lastTop = stability.readerScrollTop();
      if (correction !== 0) {
        logCorrection({ t: Date.now(), mode: 'bottom', raw, applied, scrollTop: root.scrollTop, scrollHeight: root.scrollHeight });
      }
      quiet.current = correction === 0 ? quiet.current + 1 : 0;
      return true;
    }

    const el = root.querySelector(`[data-msg-id~="${CSS.escape(h.id)}"]`) as HTMLElement | null;
    if (!el) {
      // The row being held is not in the DOM. Nothing can be corrected this
      // frame, and the hold is deliberately kept — the row may come back, since
      // "load earlier" can fold it into a capsule and re-render it. Worth
      // recording either way: a stretch of these around a jump would say the
      // reader was displaced while the anchor had nothing to measure.
      logCorrection({ t: Date.now(), mode: 'lost', raw: 0, applied: 0, scrollTop: root.scrollTop, scrollHeight: root.scrollHeight });
      return false;
    }
    const anchorTop = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
    const { correction, offset, raw } = planFrame(h.hold, {
      scrollTop: stability.readerScrollTop(),
      anchorTop,
    });
    const applied = correction !== 0 ? stability.compensate(correction, 'prepend-top') : 0;
    h.hold.offset = settledHold(offset, raw, applied);
    if (correction !== 0) {
      logCorrection({ t: Date.now(), mode: 'top', raw, applied, scrollTop: root.scrollTop, scrollHeight: root.scrollHeight });
    }
    // Read the position back instead of predicting it: the browser clamps at
    // both ends, and a predicted value that never happened would read as a user
    // scroll on the next frame and shift the anchor by the difference.
    h.hold.lastTop = stability.readerScrollTop();
    quiet.current = correction === 0 ? quiet.current + 1 : 0;
    return true;
  }, [getViewport, release, stability]);

  // A ResizeObserver only fires when the observed box changes. An image decoding
  // inside an already-sized row, a font swap, a code block gaining a scrollbar —
  // all shift content without necessarily resizing the container. So correct on
  // every frame of the settle window rather than trusting one signal.
  const pump = useCallback(() => {
    quiet.current = 0;
    if (raf.current !== null) return; // already running
    const step = () => {
      reassert();
      if (held.current && quiet.current < QUIET_FRAMES) raf.current = requestAnimationFrame(step);
      else raf.current = null;
    };
    raf.current = requestAnimationFrame(step);
  }, [reassert]);

  const rearm = useCallback(
    (ms: number = SETTLE_MS) => {
      const h = held.current;
      if (!h) return;
      h.until = Math.min(Date.now() + ms, h.maxUntil);
      // Something moved, so the pump has work again even if it had gone quiet.
      pump();
    },
    [pump]
  );

  const capture = useCallback(() => {
    const root = getViewport();
    if (!root) return;
    // A hold that is still live already knows where the reader was before the
    // history currently landing. Re-measuring now would take the displaced
    // position for the wanted one and make the displacement permanent — and on a
    // warm cache pulls arrive inside the frame that asked for them, so this
    // interleaving is the normal case rather than a rare one. Push the settle
    // window out instead and let the existing hold keep working; it tracks the
    // user's own scrolling either way (see shouldRecapture).
    if (!shouldRecapture(held.current, Date.now())) {
      rearm();
      return;
    }
    const until = Date.now() + SETTLE_MS;
    const maxUntil = Date.now() + MAX_HOLD_MS;
    let captured = false;

    // Pinned to the bottom → hold the TAIL, so a prefill prepends history above
    // and leaves the last messages where they were instead of jumping the view
    // to the top of what just arrived.
    const logicalTop = stability.logicalScrollTop();
    if (root.scrollHeight - logicalTop - root.clientHeight < BOTTOM_SLACK) {
      held.current = {
        mode: 'bottom',
        hold: { gap: root.scrollHeight - logicalTop - root.clientHeight, lastTop: stability.readerScrollTop() },
        until,
        maxUntil,
      };
      captured = true;
    } else {
      const vpTop = root.getBoundingClientRect().top;
      // The topmost message still visible — the first whose bottom edge has not
      // passed the top of the viewport — is what the user is reading, and the
      // obvious thing to hold.
      //
      // With one exception, and it is the last jump left on a phone. A run
      // capsule at the seam SWALLOWS the machinery that "load earlier" brings:
      // the same row comes back taller and starting further back in the
      // conversation, and because `data-msg-id` carries every folded id and the
      // lookup is a word match, the anchor happily finds it again and measures
      // the new, taller element's top edge. The correction then falls short by
      // exactly what the capsule absorbed — measured on a 17k-message session,
      // deterministically: content grew 544px, the anchor moved 358px, the
      // reader lost 186px, once, on the first pull after opening.
      //
      // So skip capsules and hold the first visible row that cannot grow that
      // way. A closed run always has a human-readable row below it (which is
      // why runs are NAMED after that row — see fold-runs.ts), so this almost
      // always finds one; when a screenful is nothing but machinery, fall back
      // to the topmost row rather than not anchoring at all.
      let fallback: { id: string; offset: number } | null = null;
      let pick: { id: string; offset: number } | null = null;
      for (const el of Array.from(root.querySelectorAll('[data-msg-id]'))) {
        const r = el.getBoundingClientRect();
        if (r.bottom <= vpTop) continue;
        const id = (el.getAttribute('data-msg-id') ?? '').split(' ')[0];
        if (!id) continue;
        const cand = { id, offset: r.top - vpTop };
        if (!fallback) fallback = cand;
        if (!el.hasAttribute('data-run')) {
          pick = cand;
          break;
        }
        // Only look a little way down for a stable row; past the fold it is no
        // longer describing where the reader's eyes are.
        if (r.top - vpTop > root.clientHeight) break;
      }
      const anchor = pick ?? fallback;
      if (anchor) {
        held.current = {
          mode: 'top',
          id: anchor.id,
          hold: { offset: anchor.offset, lastTop: stability.readerScrollTop() },
          until,
          maxUntil,
        };
        captured = true;
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
  }, [getViewport, pump, rearm, stability]);

  // A sleeping pump is not running `reassert`, so it is not the thing that
  // notices the window has closed. Anyone asking whether we are still holding
  // gets the deadline checked for them — otherwise a hold that went quiet would
  // read as live forever, and the scroll listener that defers to it (load
  // earlier, pin detection) would never run again.
  const isHolding = useCallback(() => {
    const h = held.current;
    if (!h) return false;
    if (Date.now() > h.until || Date.now() > h.maxUntil) {
      release();
      return false;
    }
    return true;
  }, [release]);

  useEffect(
    () => () => {
      release();
    },
    [release]
  );

  return { capture, reassert, rearm, isHolding, release };
}
