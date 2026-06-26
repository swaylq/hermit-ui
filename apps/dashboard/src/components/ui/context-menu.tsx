'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export type ContextMenuItem = {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
};

// A lightweight right-click menu: a fixed-position popup at the cursor, portaled
// to <body> so it escapes the sidebar's overflow clipping. Closes on an outside
// press, Esc, scroll, resize, or another right-click. Deliberately hand-rolled
// rather than base-ui — that path has burned us on overlay compositing (see the
// base-ui overlay-quirks note: animate-in backdrops + nested transparency).
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [pos, setPos] = useState({ x, y });

  // Clamp into the viewport once the menu has measured itself (before paint, so
  // there's no visible jump when opening near a screen edge).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: Math.max(pad, Math.min(x, window.innerWidth - r.width - pad)),
      y: Math.max(pad, Math.min(y, window.innerHeight - r.height - pad)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button === 2) return; // a right-click just opens a new menu elsewhere
      if (ref.current?.contains(e.target as Node)) return; // inside → let the item fire
      onCloseRef.current();
    };
    const close = () => onCloseRef.current();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 100 }}
      className="min-w-[150px] overflow-hidden rounded-lg border border-border bg-popover py-1 text-[13px] text-popover-foreground shadow-lg"
    >
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          onClick={() => {
            it.onClick();
            onClose();
          }}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer hover:bg-accent',
            it.danger && 'text-rose-500',
          )}
        >
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
