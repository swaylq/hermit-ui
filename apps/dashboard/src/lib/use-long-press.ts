'use client';

import { useCallback, useRef, type TouchEvent } from 'react';

// Long-press → context menu for touch devices. Desktop opens the menu on the
// native `contextmenu` (right-click) event, but a phone has no right-click and
// iOS Safari shows its OWN callout on a long-press without firing a usable
// contextmenu — so we detect the press ourselves: hold ~450ms without moving (a
// move means the user is scrolling, so bail) and fire onLongPress with the touch
// point. The touchend that follows a fired press is preventDefault'd to swallow
// the click, so a long-press never also navigates.
//
// Returns a FACTORY so a single hook call can hand each list row its own handlers
// — React hooks can't be called inside a .map(). Pair it on the target with
// `select-none [-webkit-touch-callout:none]` so iOS suppresses its native callout
// and lets our menu through.
export function useLongPress(
  onLongPress: (id: string, x: number, y: number) => void,
  ms = 450,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  return useCallback(
    (id: string) => ({
      onTouchStart: (e: TouchEvent) => {
        const t = e.touches[0];
        if (!t) return;
        start.current = { x: t.clientX, y: t.clientY };
        fired.current = false;
        clear();
        timer.current = setTimeout(() => {
          fired.current = true;
          if (start.current) onLongPress(id, start.current.x, start.current.y);
        }, ms);
      },
      onTouchMove: (e: TouchEvent) => {
        const t = e.touches[0];
        if (!t || !start.current) return;
        if (
          Math.abs(t.clientX - start.current.x) > 10 ||
          Math.abs(t.clientY - start.current.y) > 10
        ) {
          clear(); // moved → it's a scroll, not a long-press
        }
      },
      onTouchEnd: (e: TouchEvent) => {
        clear();
        if (fired.current) e.preventDefault(); // swallow the click that follows a long-press
      },
      onTouchCancel: clear,
    }),
    [onLongPress, ms, clear],
  );
}
