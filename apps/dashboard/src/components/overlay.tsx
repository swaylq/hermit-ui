'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

// Reusable modal overlay: backdrop + Esc + scroll-lock + enter/leave transitions
// (backdrop fades, panel fades + scales). Bare createPortal — NOT base-ui Dialog
// (see hermit-ui-base-ui-overlay-quirks: animate-in keyframes get stuck at
// opacity:0; we drive opacity/scale off a controlled `show` state + a plain CSS
// transition instead, which doesn't hit that bug).
//
// `children` is a render prop receiving an animated `close()` — use it for the X
// button, Cancel, and any post-action dismiss so the leave animation plays before
// the parent unmounts. (Backdrop click + Esc are wired here.)
export function Overlay({
  onClose,
  children,
  panelClassName,
  z = 110,
  interceptClose,
}: {
  onClose: () => void;
  children: (close: () => void) => ReactNode;
  panelClassName?: string;
  z?: number;
  // Esc / backdrop call this first; return true to handle it yourself (e.g. cancel
  // an in-progress edit) instead of closing. The X / explicit close use `close`.
  interceptClose?: () => boolean;
}) {
  const [show, setShow] = useState(false);

  // Enter: mount hidden, flip to shown next frame so the CSS transition runs.
  useEffect(() => {
    const r = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // Force close with the leave animation, then unmount (matches duration-150).
  const close = useCallback(() => {
    setShow(false);
    window.setTimeout(onClose, 150);
  }, [onClose]);

  // Soft dismiss (Esc / backdrop): let the child intercept first.
  const softClose = useCallback(() => {
    if (interceptClose?.()) return;
    close();
  }, [interceptClose, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') softClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [softClose]);

  return createPortal(
    <div
      className={cn('fixed inset-0 flex items-center justify-center p-4 bg-black/60 transition-opacity duration-150 ease-out', show ? 'opacity-100' : 'opacity-0')}
      style={{ zIndex: z }}
      onClick={softClose}
    >
      <div
        className={cn('transition-[opacity,transform] duration-150 ease-out', show ? 'opacity-100 scale-100' : 'opacity-0 scale-95', panelClassName)}
        onClick={(e) => e.stopPropagation()}
      >
        {children(close)}
      </div>
    </div>,
    document.body,
  );
}
