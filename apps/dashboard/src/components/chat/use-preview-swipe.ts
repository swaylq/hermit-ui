'use client';

// Pull the live preview out of the right edge with your thumb.
//
// preview-tab.tsx is the handle you tap; this is the same drawer's other half,
// the one you drag. It is the mirror image of the mobile nav drawer
// (app-sidebar.tsx): a zone at the edge starts the gesture, SLOP px decide
// horizontal from vertical, the panel tracks the finger, and a flick or a third
// of the screen settles it. Phones only — on lg+ the panel is a split beside the
// chat with a divider of its own, so there is no drawer there to pull.
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
// Closing works from wherever a touch actually reaches us — the header and the
// safe-area padding. Not from over the iframe: those touches never leave it,
// being another origin's document. So the header is the grabber, the way it is
// on a sheet.

import { useEffect, useRef, type RefObject } from 'react';
import { nativeHaptic } from '@/lib/native-bridge';

/** Right-edge zone that can start an OPEN pull. Wider than the drawer's 28 on the
 *  left because the tab lives in it: a pull that starts ON the handle has to be
 *  the same gesture as one that starts beside it, and the tab is 34px. */
const EDGE = 36;
/** Travel before horizontal vs vertical is called. Below it, this may still be a scroll. */
const SLOP = 10;
/** px/ms. Above this the flick's direction settles it, however far it got. */
const FLICK = 0.3;
/** Otherwise: how much of the screen the panel has to cross. Asymmetric by
 *  construction — from closed you pull COMMIT in, from open you push COMMIT back
 *  out — so neither state sits one twitch away from flipping. */
const COMMIT = 0.35;
/** Must match SLIDE_MS in preview-panel.tsx: the CSS travel we hand back to. */
const SETTLE_MS = 300;
/** A finger that has held still this long is not flicking any more, whatever it
 *  was doing before. Without this, parking the panel half-open and then lifting
 *  is settled by a flick that ended a second ago. */
const STALE_MS = 80;
/** The nav drawer's own edge zone (app-sidebar.tsx). A close-drag starting inside
 *  it would pull the sidebar in underneath us at the same time — both listeners
 *  sit on document, both read a rightward drag, and that one runs first. */
const DRAWER_EDGE = 28;

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
    let chaseRaf = 0, clearTimer = 0;

    const isPhone = () => window.matchMedia('(max-width: 1023px)').matches;

    const paint = (): boolean => {
      const el = panelRef.current;
      if (!el) return false;
      el.style.transition = 'none';
      el.style.transform = `translateX(${tx}px)`;
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
      if (clearTimer) { window.clearTimeout(clearTimer); clearTimer = 0; }
      stopChase();
      // A second finger landing mid-pull: settle where we stand. Dropping the
      // gesture instead would strand the panel at a half transform with the
      // touchend that could have finished it already disowned.
      if (engaged) { onEnd(e); return; }
      if (!isPhone() || e.touches.length !== 1) { mode = null; return; }
      const t = e.touches[0];
      width = window.innerWidth;
      if (openRef.current) {
        if (t.clientX <= DRAWER_EDGE) { mode = null; return; }
        mode = 'close';
      } else if (t.clientX >= width - EDGE) {
        mode = 'open';
      } else {
        mode = null;
        return;
      }
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
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        decided = true;
        const inwards = mode === 'open' ? dx < 0 : dx > 0;
        engaged = Math.abs(dx) > Math.abs(dy) && inwards;
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
      const past = 1 - tx / width > (mode === 'close' ? 1 - COMMIT : COMMIT);
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
      const settleOpen = Math.abs(vx) > FLICK ? vx < 0 : willOpen;
      const el = panelRef.current;
      if (el) {
        // Hand the rest of the travel back to the class's transition, but through
        // the inline transform — clearing it here would snap the panel to
        // whatever the class says one frame before React agrees.
        el.style.transition = '';
        el.style.transform = settleOpen ? 'translateX(0)' : `translateX(${width}px)`;
        clearTimer = window.setTimeout(() => {
          clearTimer = 0;
          const cur = panelRef.current; // gone already, if it closed and unmounted
          if (!cur) return;
          cur.style.transition = '';
          cur.style.transform = '';
        }, SETTLE_MS);
      }
      settleRef.current(settleOpen);
      mode = null; engaged = false;
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      stopChase();
      if (clearTimer) window.clearTimeout(clearTimer);
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [url, panelRef]);
}
