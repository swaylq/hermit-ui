'use client';

// "Open this session AT this message" — what a search hit needs and what the
// normal timeline can't do. chat.listMessages only ever returns the newest N
// rows, so reaching a hit 20,000 messages deep would take a hundred "load
// earlier" clicks. This hook swaps the timeline over to a window centred on one
// message (chat.listMessagesAround), scrolls to it, and flashes it.
//
// Anchored mode is deliberately FROZEN: no SSE writes, no tail-follow, no
// auto-scroll to bottom. You're reading history. "回到最新" leaves anchored mode
// and the ordinary live timeline resumes.

import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import type { ScrollStability } from './use-scroll-stability';

const STEP = 60;
const FLASH_MS = 1600;
// Frames to wait for the anchor row to mount before giving up (~1s at 60fps).
const WAIT_FRAMES = 60;
// Re-assert the scroll position at these delays, covering async layout growth
// above the anchor (markdown, syntax highlighting, images).
const SETTLE_MS = [120, 400, 900];

export type AnchoredWindow = {
  active: boolean;
  anchorId: string | null;
  rows: Array<{ id: string; role: string; content: unknown; createdAt: Date | string }> | null;
  loading: boolean;
  hasBefore: boolean;
  loadEarlier: () => void;
  /** Re-centre on another message — the in-session find stepping to a match
   *  that isn't in the loaded window. */
  jumpTo: (messageId: string) => void;
  clear: () => void;
};

export function useAnchoredWindow(
  sessionId: string,
  initialMessageId: string | null,
  getViewport: () => HTMLElement | null,
  stability: ScrollStability,
): AnchoredWindow {
  const [anchorId, setAnchorId] = useState<string | null>(initialMessageId);
  const [before, setBefore] = useState(STEP);
  const scrolledFor = useRef<string | null>(null);

  // A new `msg` param (clicking a second search hit while already anchored)
  // re-anchors and resets the window growth. Adjusted DURING RENDER rather than
  // in an effect — React re-renders immediately with the new state instead of
  // painting one frame at the stale anchor first.
  const [appliedInitial, setAppliedInitial] = useState(initialMessageId);
  if (initialMessageId && initialMessageId !== appliedInitial) {
    setAppliedInitial(initialMessageId);
    setAnchorId(initialMessageId);
    setBefore(STEP);
  }
  // Reset the "already scrolled" latch out of band — refs must not be written
  // during render.
  useEffect(() => {
    scrolledFor.current = null;
  }, [appliedInitial]);

  const q = trpc.chat.listMessagesAround.useQuery(
    { sessionId, messageId: anchorId ?? '', before, after: STEP },
    { enabled: !!anchorId && !!sessionId, staleTime: 5 * 60_000 }
  );

  // Scroll to the anchor once its row exists in the DOM, then hold it there
  // while the window finishes laying out.
  //
  // Two separate problems, hence two loops. The row may not be mounted on the
  // first frame (WAIT), and once it is, everything above it is still growing —
  // markdown parses, code highlights, images get their intrinsic size — and each
  // of those pushes the anchor down (SETTLE). One scroll on one frame lands the
  // message somewhere near the fold on a slow device; re-asserting for a beat
  // afterwards is what makes it reliably land where the user is looking.
  useEffect(() => {
    if (!anchorId || !q.data || q.data.rows.length === 0) return;
    if (scrolledFor.current === anchorId) return;
    let cancelled = false;
    let waits = 0;
    const timers: number[] = [];
    let expectedReaderTop: number | null = null;
    let settleAborted = false;

    const centre = (flash: boolean): boolean => {
      const root = getViewport();
      const el = root?.querySelector(`[data-msg-id~="${CSS.escape(anchorId)}"]`) as HTMLElement | null;
      if (!root || !el) return false;
      if (!flash) {
        const readerMoved = expectedReaderTop !== null
          && Math.abs(stability.readerScrollTop() - expectedReaderTop) > 1;
        const nativeMoving = stability.isScrolling() && !stability.isProgrammatic();
        if (settleAborted || readerMoved || nativeMoving) {
          // The delayed passes exist only for async layout settling. Once the
          // reader touches or moves the viewport, that position belongs to them
          // and no 120/400/900ms retry may take it back.
          settleAborted = true;
          return true;
        }
      }
      const r = el.getBoundingClientRect();
      const vp = root.getBoundingClientRect();
      // A third from the top, not the middle: the interesting part of a hit is
      // usually the reply that follows it.
      stability.scrollBy(r.top - vp.top - vp.height / 3, 'auto', flash ? 'anchor-jump' : 'anchor-settle');
      expectedReaderTop = stability.readerScrollTop();
      if (flash) {
        el.classList.add('chat-anchor-flash');
        timers.push(window.setTimeout(() => el.classList.remove('chat-anchor-flash'), FLASH_MS));
      }
      return true;
    };

    const tryScroll = () => {
      if (cancelled) return;
      if (!centre(true)) {
        if (++waits < WAIT_FRAMES) requestAnimationFrame(tryScroll);
        return;
      }
      scrolledFor.current = anchorId;
      for (const delay of SETTLE_MS) {
        timers.push(window.setTimeout(() => {
          if (!cancelled) centre(false);
        }, delay));
      }
    };
    requestAnimationFrame(tryScroll);

    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [anchorId, q.data, getViewport, stability]);

  const clear = useCallback(() => {
    setAnchorId(null);
    scrolledFor.current = null;
    // Drop `msg` from the URL so a refresh doesn't jump back into history.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (url.searchParams.has('msg')) {
        url.searchParams.delete('msg');
        window.history.replaceState(null, '', url.toString());
      }
    }
  }, []);

  const loadEarlier = useCallback(() => setBefore((b) => b + STEP), []);

  const jumpTo = useCallback((messageId: string) => {
    setAnchorId(messageId);
    setBefore(STEP);
    scrolledFor.current = null;
  }, []);

  return {
    active: !!anchorId,
    anchorId,
    rows: anchorId ? (q.data?.rows ?? null) : null,
    loading: !!anchorId && q.isPending,
    hasBefore: !!q.data?.hasBefore,
    loadEarlier,
    jumpTo,
    clear,
  };
}
