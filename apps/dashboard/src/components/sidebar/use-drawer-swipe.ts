'use client';

// Interactive swipe to open / close the mobile nav drawer.
//
// Edge-swipe right (from the left ~28px) opens; swipe left (anywhere) closes.
// The drawer tracks the finger and snaps open/closed past the halfway point or
// on a flick. Desktop (lg+) is untouched — isMobile() gates the whole thing, and
// the sidebar is static there. On release the styling goes back to the className
// so a later button/backdrop toggle still animates normally.
//
// Lifted out of app-sidebar.tsx unchanged in behaviour except for the haptics
// below. It moved for two reasons: 90 lines of imperative touch handling had no
// business inside a 560-line component that is otherwise all markup, and out
// here it can be driven by synthetic touches on its own
// (projects/preview-swipe-harness in the agent workspace) — the component itself
// drags in tRPC and next/navigation and cannot be mounted in a bare page.
//
// The live-preview panel pulls out of the RIGHT edge with the same gesture and
// the same numbers (components/chat/use-preview-swipe.ts). The two are kept as
// separate files rather than one parameterised hook because what differs is
// structural, not a setting: this drawer is always in the DOM and drags a
// backdrop's opacity with it; that one mounts a lazy panel mid-gesture and has
// no backdrop.

import { useEffect, useRef, type RefObject } from 'react';
import { nativeHaptic } from '@/lib/native-bridge';

const W = 280;      // drawer width (matches w-[280px])
const EDGE = 28;    // left-edge zone that can start an OPEN gesture
const SLOP = 10;    // px of travel before we commit to horizontal vs vertical
const FLICK = 0.3;  // px/ms — above this the flick's direction wins over distance
/** A finger that has held still this long is not flicking any more, whatever it
 *  was doing before. Without this, parking the drawer half-open and then lifting
 *  is settled by a flick that ended a second ago — and the haptic below would
 *  have promised the opposite outcome. */
const STALE_MS = 80;

export function useDrawerSwipe({
  open,
  setOpen,
  asideRef,
  backdropRef,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  asideRef: RefObject<HTMLElement | null>;
  backdropRef: RefObject<HTMLElement | null>;
}) {
  // Read at gesture time, not at bind time, so the listeners can stay put.
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;
    const backdrop = backdropRef.current;

    let mode: 'open' | 'close' | null = null;
    let startX = 0, startY = 0, lastX = 0, lastT = 0, vx = 0, curTx = 0;
    let decided = false, engaged = false, willOpen = false, clearTimer = 0;

    const isMobile = () => window.matchMedia('(max-width: 1023px)').matches;

    const paint = (tx: number) => {
      curTx = tx;
      aside.style.transition = 'none';
      aside.style.transform = `translateX(${tx}px)`;
      if (backdrop) {
        const p = Math.max(0, Math.min(1, (tx + W) / W));
        backdrop.style.transition = 'none';
        backdrop.style.opacity = String(p);
        backdrop.style.pointerEvents = p > 0.01 ? 'auto' : 'none';
      }
    };
    const restore = () => {
      aside.style.transition = '';
      aside.style.transform = '';
      if (backdrop) { backdrop.style.transition = ''; backdrop.style.opacity = ''; backdrop.style.pointerEvents = ''; }
    };

    const onStart = (e: TouchEvent) => {
      if (clearTimer) { window.clearTimeout(clearTimer); clearTimer = 0; }
      // A second finger landing mid-drag: settle where we stand. Dropping the
      // gesture instead would leave the drawer parked at a half transform, with
      // the touchend that could have finished it already disowned.
      if (engaged) { onEnd(e); return; }
      if (!isMobile() || e.touches.length !== 1) { mode = null; return; }
      const t = e.touches[0];
      if (openRef.current) mode = 'close';
      else if (t.clientX <= EDGE) mode = 'open';
      else { mode = null; return; }
      startX = lastX = t.clientX; startY = t.clientY; lastT = e.timeStamp;
      decided = false; engaged = false; vx = 0;
      willOpen = openRef.current;
    };
    const onMove = (e: TouchEvent) => {
      if (mode === null) return;
      const t = e.touches[0];
      const dx = t.clientX - startX, dy = t.clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        decided = true;
        const rightDir = mode === 'open' ? dx > 0 : dx < 0;
        engaged = Math.abs(dx) > Math.abs(dy) && rightDir;
        if (!engaged) { mode = null; return; } // a vertical scroll — let it through
      }
      e.preventDefault(); // we own this horizontal gesture; block page scroll
      const now = e.timeStamp;
      if (now > lastT) vx = (t.clientX - lastX) / (now - lastT);
      lastX = t.clientX; lastT = now;
      const base = mode === 'open' ? -W : 0;
      paint(Math.max(-W, Math.min(0, base + dx)));
      // Say which side of the halfway point we are on BEFORE the finger lifts.
      // A drawer under a thumb covers the very edge that would otherwise show
      // how far it has come, so the answer arrives as a tick — the one a picker
      // gives crossing a detent, not a thud.
      const past = (curTx + W) / W > 0.5;
      if (past !== willOpen) {
        willOpen = past;
        nativeHaptic('selection');
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (mode === null || !engaged) { mode = null; return; }
      if (e.timeStamp - lastT > STALE_MS) vx = 0;
      const open = Math.abs(vx) > FLICK ? vx > 0 : willOpen; // flick wins, else halfway
      aside.style.transition = '';                     // re-enable the CSS transition
      aside.style.transform = open ? 'translateX(0)' : `translateX(-${W}px)`;
      if (backdrop) { backdrop.style.transition = ''; backdrop.style.opacity = open ? '1' : '0'; backdrop.style.pointerEvents = open ? 'auto' : 'none'; }
      setOpen(open);
      clearTimer = window.setTimeout(restore, 240); // hand control back to className
      mode = null; engaged = false;
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      if (clearTimer) window.clearTimeout(clearTimer);
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [setOpen, asideRef, backdropRef]);
}
