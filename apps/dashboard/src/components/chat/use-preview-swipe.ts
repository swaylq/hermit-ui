'use client';

// Pull the live preview out of the right edge with your thumb.
//
// preview-tab.tsx is the handle you tap; this is the same drawer's other half,
// the one you drag. It is the mirror image of the mobile nav drawer
// (components/sidebar/use-drawer-swipe.ts): a zone at the edge starts the
// gesture, SLOP px decide horizontal from vertical, the panel tracks the finger,
// and a flick or a third of the screen settles it. Phones only — on lg+ the
// panel is a split beside the chat with a divider of its own, so there is no
// drawer there to pull.
//
// One thing is NOT a mirror. The nav drawer is always in the DOM, so it has
// something to drag from the first frame. This panel is lazy-loaded and
// unmounted while closed, because it holds a cross-origin iframe nobody wants to
// fetch until it is asked for. So the gesture mounts it itself (`onPrime`) — not
// on touchstart, which would fetch the agent's page every time a thumb scrolled
// the transcript near the edge, but on the frame the drag is known to be
// horizontal. Until React has painted it there is nothing to move, so the offset
// is remembered and applied by the first frame that finds the element.
//
// This side sees only the touches that land on the DASHBOARD: the panel's header
// and its padding. A finger on the previewed page itself is in another origin's
// document and never reaches here — that half of the push-back is forwarded by
// the bridge and replayed in preview-panel.tsx, through the same preview-drag.ts.

import { useEffect, useRef, type RefObject } from 'react';
import { nativeHaptic } from '@/lib/native-bridge';
import { paintLayer, settleLayer, settlesOpen, willCommit, SLOP, EDGE_SLOP, STALE_MS } from '@/components/chat/preview-drag';

/** Right-edge zone that can start an OPEN pull. Wider than the drawer's 28 on the
 *  left because the tab lives in it: a pull that starts ON the handle has to be
 *  the same gesture as one that starts beside it, and the tab is 34px. */
const EDGE = 36;

export function usePreviewSwipe({
  url,
  open,
  panelRef,
  onPrime,
  onSettle,
}: {
  /** The session's registered preview, or null — with no preview there is no gesture. */
  url: string | null;
  /** Open in the settled sense (fully in), which is what decides open-pull vs close-push. */
  open: boolean;
  /** The panel's root, once it is mounted. Null through the whole first pull. */
  panelRef: RefObject<HTMLElement | null>;
  /** Mount the panel closed, so the finger has something to drag. */
  onPrime: (url: string) => void;
  /** Where the gesture ended up: true finishes opening, false finishes closing. */
  onSettle: (open: boolean) => void;
}) {
  // Read at gesture time, not at bind time, so the listeners can stay put.
  const openRef = useRef(open);
  openRef.current = open;
  const primeRef = useRef(onPrime);
  primeRef.current = onPrime;
  const settleRef = useRef(onSettle);
  settleRef.current = onSettle;

  useEffect(() => {
    if (!url) return;

    let mode: 'open' | 'close' | null = null;
    let startX = 0, startY = 0, lastX = 0, lastT = 0, vx = 0;
    let width = 0, tx = 0;
    let decided = false, engaged = false, willOpen = false;
    let chaseRaf = 0, clearTimer: ReturnType<typeof setTimeout> | null = null;

    const isPhone = () => window.matchMedia('(max-width: 1023px)').matches;

    const paint = (): boolean => {
      const el = panelRef.current;
      if (!el) return false;
      paintLayer(el, tx);
      return true;
    };
    // The panel is still mounting. Keep trying, so a finger that has stopped
    // moving mid-pull still gets the drawer under it.
    const chase = () => {
      chaseRaf = 0;
      if (mode === null || paint()) return;
      chaseRaf = requestAnimationFrame(chase);
    };
    const stopChase = () => {
      if (chaseRaf) cancelAnimationFrame(chaseRaf);
      chaseRaf = 0;
    };

    const onStart = (e: TouchEvent) => {
      if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
      stopChase();
      // A second finger landing mid-pull: settle where we stand. Dropping the
      // gesture instead would strand the panel at a half transform with the
      // touchend that could have finished it already disowned.
      if (engaged) { onEnd(e); return; }
      if (!isPhone() || e.touches.length !== 1) { mode = null; return; }
      const t = e.touches[0];
      width = window.innerWidth;
      // Open: only from the right edge. Closed-ward: from anywhere the touch
      // reaches us at all, which while the panel covers the screen means its
      // header and padding — the left edge included, because a full-screen layer
      // is up and the nav drawer's own edge-pull stands down under one
      // (use-drawer-swipe.ts, `[data-covers-viewport]`).
      if (openRef.current) mode = 'close';
      else if (t.clientX >= width - EDGE) mode = 'open';
      else { mode = null; return; }
      startX = lastX = t.clientX; startY = t.clientY; lastT = e.timeStamp;
      tx = mode === 'open' ? width : 0;
      decided = false; engaged = false; vx = 0;
      willOpen = mode === 'close';
    };

    const onMove = (e: TouchEvent) => {
      if (mode === null) return;
      const t = e.touches[0];
      const dx = t.clientX - startX, dy = t.clientY - startY;
      if (!decided) {
        const ax = Math.abs(dx), ay = Math.abs(dy);
        if (!ax && !ay) return;
        if (mode === 'open') {
          // The edge zone belongs to the pull, and the call has to be made on the
          // first move that says anything: a touchmove that goes unprevented can
          // hand the whole gesture to the scroller, which then keeps it — that is
          // how the transcript ended up sliding under a panel being pulled out.
          if (ay > ax) { mode = null; return; }        // plainly a scroll: never touched
          if (!e.cancelable) { mode = null; return; }  // already scrolling: leave it alone
          e.preventDefault();                          // hold the scroller off while we look
          if (Math.max(ax, ay) < EDGE_SLOP) return;    // held, but not committed yet
        } else if (ax < SLOP && ay < SLOP) {
          return;
        }
        decided = true;
        const inwards = mode === 'open' ? dx < 0 : dx > 0;
        engaged = ax > ay && inwards;
        if (engaged && !e.cancelable) engaged = false;
        if (!engaged) { mode = null; return; } // a scroll, or a pull the wrong way
        if (mode === 'open') primeRef.current(url);
      }
      e.preventDefault(); // this horizontal drag is ours; the page must not scroll under it
      const now = e.timeStamp;
      if (now > lastT) vx = (t.clientX - lastX) / (now - lastT);
      lastX = t.clientX; lastT = now;
      tx = Math.max(0, Math.min(width, (mode === 'open' ? width : 0) + dx));
      // Say when letting go would keep it, before the finger lifts — the detent
      // tick a picker gives, not a thud.
      const past = willCommit(tx, width, mode === 'close');
      if (past !== willOpen) {
        willOpen = past;
        nativeHaptic('selection');
      }
      if (!paint()) chase();
    };

    const onEnd = (e: TouchEvent) => {
      stopChase();
      if (mode === null || !engaged) { mode = null; return; }
      if (e.timeStamp - lastT > STALE_MS) vx = 0;
      const settleOpen = settlesOpen({ tx, width, vx, wasOpen: mode === 'close' });
      const el = panelRef.current;
      if (el) clearTimer = settleLayer(el, settleOpen, width);
      settleRef.current(settleOpen);
      mode = null; engaged = false;
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      stopChase();
      if (clearTimer) clearTimeout(clearTimer);
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [url, panelRef]);
}
