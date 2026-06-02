'use client';

// Full-screen, zoomable image viewer. Opened by clicking an image in a chat
// bubble (previously a plain `<a target="_blank">` that yanked you to a new
// tab). Interactions:
//   · wheel / pinch          → zoom around the pointer (or pinch midpoint)
//   · tap / click the image  → toggle fit ⇄ 2.5×, zooming toward the tap
//   · drag                   → pan (only meaningful once zoomed in)
//   · −/＋/percentage buttons → zoom out / in / reset (thumb-reachable on phones)
//   · click the backdrop     → close · Escape → close
//
// Built on a bare `createPortal` overlay rather than the base-ui Dialog: in this
// build the Dialog's Popup/Backdrop layer broke partial-alpha painting (a
// semi-transparent dim composited to fully transparent over the image's
// `will-change` layer) and its `animate-in` left the backdrop at opacity:0. A
// plain portal paints the dim reliably and we own scroll-lock / Escape outright.
// Transform state lives in a ref and is written straight to the node's
// `style.transform` so a pan stays at 60fps without re-rendering React.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

const MIN_SCALE = 1;
const MAX_SCALE = 6;

type View = { scale: number; tx: number; ty: number };

export function ImageLightbox({
  open,
  onOpenChange,
  url,
  alt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  alt?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const view = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  // Mirror of `view.scale` used only for UI (cursor + percentage label). The
  // live transform is driven by the ref, not this, so pans don't re-render.
  const [scale, setScale] = useState(1);

  // Active touch/mouse pointers, plus the in-progress pinch / drag gesture.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number } | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const moved = useRef(false);

  // Keep the displayed image covering — and never escaping — the container, so
  // a pan can't fling it into the void. maxOffset = (displayed − container)/2.
  const clamp = useCallback((v: View): View => {
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale));
    let { tx, ty } = v;
    const img = imgRef.current;
    const cont = containerRef.current;
    if (img && cont) {
      const maxX = Math.max(0, (img.offsetWidth * s - cont.clientWidth) / 2);
      const maxY = Math.max(0, (img.offsetHeight * s - cont.clientHeight) / 2);
      tx = Math.min(maxX, Math.max(-maxX, tx));
      ty = Math.min(maxY, Math.max(-maxY, ty));
    }
    return { scale: s, tx, ty };
  }, []);

  const apply = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const { scale: s, tx, ty } = view.current;
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  }, []);

  const set = useCallback(
    (next: View) => {
      view.current = clamp(next);
      apply();
      setScale(view.current.scale);
    },
    [apply, clamp],
  );

  // Zoom to `nextScale` while keeping the screen point (cx, cy) pinned under the
  // cursor. The image is centered in the container, so its transform-origin (its
  // own center) sits at the container center C; solving screen(p)=C+t+s·(p−C)
  // for the fixed point gives t' = rel − s'·(rel − t)/s, rel = cursor − C.
  const zoomAround = useCallback(
    (nextScale: number, cx: number, cy: number) => {
      const cont = containerRef.current;
      const s = view.current.scale;
      const s2 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
      if (!cont) {
        set({ ...view.current, scale: s2 });
        return;
      }
      const rect = cont.getBoundingClientRect();
      const relX = cx - (rect.left + rect.width / 2);
      const relY = cy - (rect.top + rect.height / 2);
      set({
        scale: s2,
        tx: relX - (s2 * (relX - view.current.tx)) / s,
        ty: relY - (s2 * (relY - view.current.ty)) / s,
      });
    },
    [set],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const cont = containerRef.current;
      const rect = cont?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : 0;
      const cy = rect ? rect.top + rect.height / 2 : 0;
      zoomAround(view.current.scale * factor, cx, cy);
    },
    [zoomAround],
  );

  const reset = useCallback(() => set({ scale: 1, tx: 0, ty: 0 }), [set]);

  // Fresh image / fresh open → start fit-to-screen, centered.
  useEffect(() => {
    if (!open) return;
    view.current = { scale: 1, tx: 0, ty: 0 };
    setScale(1);
    const id = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(id);
  }, [open, url, apply]);

  // Escape closes; the page underneath is scroll-locked while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onOpenChange]);

  // Wheel zoom. Attached natively (not via React's onWheel, which is passive and
  // would swallow preventDefault) so the trackpad can't bounce the page.
  useEffect(() => {
    const cont = containerRef.current;
    if (!open || !cont) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAround(view.current.scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    cont.addEventListener('wheel', onWheel, { passive: false });
    return () => cont.removeEventListener('wheel', onWheel);
  }, [open, zoomAround]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
      drag.current = null;
    } else {
      drag.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty };
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size >= 2 && pinch.current) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        zoomAround(view.current.scale * (dist / (pinch.current.dist || dist)), cx, cy);
        pinch.current = { dist };
        moved.current = true;
      } else if (drag.current) {
        const dx = e.clientX - drag.current.x;
        const dy = e.clientY - drag.current.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved.current = true;
        set({ scale: view.current.scale, tx: drag.current.tx + dx, ty: drag.current.ty + dy });
      }
    },
    [set, zoomAround],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const wasMoved = moved.current;
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
      if (pointers.current.size > 0) return;
      drag.current = null;
      if (wasMoved) return; // a drag/pinch, not a tap — don't toggle or close
      const onImage = imgRef.current?.contains(e.target as Node);
      if (!onImage) {
        onOpenChange(false); // tapped the backdrop area
      } else if (view.current.scale > 1.01) {
        reset(); // already zoomed → back to fit
      } else {
        zoomAround(2.5, e.clientX, e.clientY); // fit → zoom toward the tap
      }
    },
    [onOpenChange, reset, zoomAround],
  );

  if (!open || typeof document === 'undefined') return null;

  const zoomed = scale > 1.01;

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Opaque near-black, NOT a semi-transparent dim: partial alpha gets reduced
      // by compositing here (the image's transform layer), so `rgba(…,0.9)` paints
      // as a weak ~40% wash. A solid backdrop is the standard lightbox look anyway
      // — full focus on the image — and paints at full strength reliably.
      style={{ backgroundColor: 'rgb(9,9,11)' }}
      className={cn(
        'fixed inset-0 z-[100] flex touch-none select-none items-center justify-center overflow-hidden',
        zoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in',
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={url}
        alt={alt ?? 'image'}
        draggable={false}
        onLoad={() => set(view.current)}
        style={{ transformOrigin: 'center' }}
        className="max-h-[92dvh] max-w-[92vw] object-contain"
      />

      {/* Controls float above the image; the layer is click-through
          (pointer-events-none) so taps between buttons still close. */}
      <div className="pointer-events-none absolute inset-0">
        <button
          type="button"
          aria-label="close"
          onClick={() => onOpenChange(false)}
          className="pointer-events-auto absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="pointer-events-auto absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/45 p-1 text-white/90 backdrop-blur-sm">
          <button
            type="button"
            aria-label="zoom out"
            onClick={() => zoomBy(1 / 1.5)}
            disabled={!zoomed}
            className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-white/15 disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="reset zoom"
            onClick={reset}
            className="min-w-[3.25rem] rounded-full px-2 text-center font-mono text-xs tabular-nums transition-colors hover:bg-white/15"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            aria-label="zoom in"
            onClick={() => zoomBy(1.5)}
            disabled={scale >= MAX_SCALE - 0.01}
            className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-white/15 disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <span className="mx-0.5 h-4 w-px bg-white/20" />
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="open original in a new tab"
            onClick={(e) => e.stopPropagation()}
            className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-white/15"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}
