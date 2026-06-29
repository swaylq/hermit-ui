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
import { X, ZoomIn, ZoomOut, ExternalLink, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { saveFile } from '@/lib/save-file';

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const SWIPE_MIN = 45;       // px of horizontal travel that counts as a navigation swipe
const LONG_PRESS_MS = 500;  // touch-hold that summons the save menu

type View = { scale: number; tx: number; ty: number };

export function ImageLightbox({
  open,
  onOpenChange,
  url,
  alt,
  // When set, ← / → (and the on-screen arrows) step through every element on the
  // page matching this selector that carries a `data-lightbox-src` attribute —
  // i.e. all chat images — turning the viewer into a gallery. Omit it for a
  // single-image viewer (e.g. composer attachment previews).
  siblingSelector,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  alt?: string;
  siblingSelector?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const view = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  // Mirror of `view.scale` used only for UI (cursor + percentage label). The
  // live transform is driven by the ref, not this, so pans don't re-render.
  const [scale, setScale] = useState(1);

  // Gallery: the image actually shown (starts at the clicked `url`, then ← / →
  // walk the siblings), plus how many siblings exist (to decide whether to show
  // the arrows at all). Both are no-ops without `siblingSelector`.
  const [currentUrl, setCurrentUrl] = useState(url);
  const [galleryCount, setGalleryCount] = useState(0);

  // Long-press (touch) → a small save menu at the press point. The PWA suppresses
  // the native "Save Image" callout (select-none), so this is the way to save there.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);

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

  // Step to the previous / next gallery image (wraps around). Reads the live DOM
  // each call so the set always reflects what's actually rendered in the timeline.
  const navigate = useCallback(
    (dir: 1 | -1) => {
      if (!siblingSelector) return;
      const urls = Array.from(document.querySelectorAll<HTMLElement>(siblingSelector))
        .map((el) => el.getAttribute('data-lightbox-src') || '')
        .filter(Boolean);
      if (urls.length < 2) return;
      const i = urls.indexOf(currentUrl);
      const next = i < 0 ? 0 : (i + dir + urls.length) % urls.length;
      if (urls[next]) { setCurrentUrl(urls[next]); setMenu(null); }
    },
    [siblingSelector, currentUrl],
  );

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current != null) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  // Save the image currently shown — reuses chat's touch-vs-desktop share/download
  // gate, so it lands in the iOS share sheet ("Save Image" / "Save to Files").
  const saveImage = useCallback(() => {
    let name = 'image';
    try { name = decodeURIComponent(currentUrl.split('/').pop()?.split('?')[0] || '') || 'image'; } catch { /* keep default */ }
    void saveFile(currentUrl, name).catch(() => { /* fetch failed or share cancelled */ });
  }, [currentUrl]);

  // On open, snap to the clicked image, count the gallery (drives the arrows), and
  // clear any stale menu. On close, drop the menu + any pending long-press timer.
  useEffect(() => {
    if (!open) { clearLongPress(); setMenu(null); return; }
    setCurrentUrl(url);
    setMenu(null);
    setGalleryCount(siblingSelector ? document.querySelectorAll(siblingSelector).length : 0);
  }, [open, url, siblingSelector, clearLongPress]);

  // Fresh image (fresh open OR ← / → navigation) → start fit-to-screen, centered.
  useEffect(() => {
    if (!open) return;
    view.current = { scale: 1, tx: 0, ty: 0 };
    setScale(1);
    const id = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(id);
  }, [open, currentUrl, apply]);

  // Keyboard: Escape closes; ← / → walk the gallery. Kept separate from the
  // scroll-lock effect so re-subscribing on each navigation (navigate changes
  // with currentUrl) doesn't thrash the body's overflow.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
      else if (e.key === 'ArrowLeft') { e.preventDefault(); navigate(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navigate(1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange, navigate]);

  // Scroll-lock the page underneath while open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

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
    // Pointers that start on a control (close · arrows · zoom bar · save menu) are
    // the control's own — don't capture or run pan/tap/close, or the container eats
    // the tap (the "buttons do nothing on touch" bug).
    if ((e.target as Element)?.closest?.('[data-lightbox-control]')) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    clearLongPress();
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
      drag.current = null;
    } else {
      drag.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty };
      // Touch long-press on the image → save menu (PWA suppresses the native one).
      if (e.pointerType === 'touch' && imgRef.current?.contains(e.target as Node)) {
        const px = e.clientX, py = e.clientY;
        longPressed.current = false;
        longPressTimer.current = window.setTimeout(() => {
          if (!moved.current) { longPressed.current = true; setMenu({ x: px, y: py }); }
        }, LONG_PRESS_MS);
      }
    }
  }, [clearLongPress]);

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
        clearLongPress();
      } else if (drag.current) {
        const dx = e.clientX - drag.current.x;
        const dy = e.clientY - drag.current.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) { moved.current = true; clearLongPress(); }
        set({ scale: view.current.scale, tx: drag.current.tx + dx, ty: drag.current.ty + dy });
      }
    },
    [set, zoomAround, clearLongPress],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as Element)?.closest?.('[data-lightbox-control]')) return; // control's own tap
      const wasMoved = moved.current;
      const start = drag.current;
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
      if (pointers.current.size > 0) return;
      drag.current = null;
      clearLongPress();
      if (longPressed.current) { longPressed.current = false; return; } // the press that opened the menu
      if (menu) { setMenu(null); return; }                              // any later tap dismisses the menu
      // Swipe to navigate — only when not zoomed (a zoomed drag pans instead).
      if (wasMoved && view.current.scale <= 1.01 && start) {
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.4) {
          navigate(dx < 0 ? 1 : -1); // swipe left → next, right → previous
          return;
        }
      }
      if (wasMoved) return; // a pan / pinch, not a tap — don't toggle or close
      const onImage = imgRef.current?.contains(e.target as Node);
      if (!onImage) {
        onOpenChange(false); // tapped the backdrop area
      } else if (e.pointerType === 'touch') {
        // On touch, a single tap closes the viewer (not zoom-toggle) — zooming
        // on phones is pinch or the −/＋ buttons. Desktop keeps click-to-zoom.
        onOpenChange(false);
      } else if (view.current.scale > 1.01) {
        reset(); // already zoomed → back to fit
      } else {
        zoomAround(2.5, e.clientX, e.clientY); // fit → zoom toward the tap
      }
    },
    [onOpenChange, reset, zoomAround, navigate, menu, clearLongPress],
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
        src={currentUrl}
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
          data-lightbox-control
          aria-label="close"
          onClick={() => onOpenChange(false)}
          className="pointer-events-auto absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Gallery prev/next — shown only when there's more than one chat image.
            Mirrors the close button's pattern (pointer-events-auto + onClick). */}
        {galleryCount > 1 && (
          <>
            <button
              type="button"
              data-lightbox-control
              aria-label="previous image"
              onClick={() => navigate(-1)}
              className="pointer-events-auto absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white sm:left-3"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              type="button"
              data-lightbox-control
              aria-label="next image"
              onClick={() => navigate(1)}
              className="pointer-events-auto absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white sm:right-3"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </>
        )}

        <div data-lightbox-control className="pointer-events-auto absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/45 p-1 text-white/90 backdrop-blur-sm">
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
          <button
            type="button"
            aria-label="save image"
            onClick={saveImage}
            className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-white/15"
          >
            <Download className="h-4 w-4" />
          </button>
          <a
            href={currentUrl}
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

      {/* Long-press save menu (touch). Marked data-lightbox-control so the
          container's pointer handlers leave its taps to the buttons. */}
      {menu && (
        <div
          data-lightbox-control
          className="pointer-events-auto fixed z-[110] min-w-[168px] overflow-hidden rounded-xl border border-white/10 bg-zinc-800/95 text-white shadow-2xl backdrop-blur"
          style={{
            left: Math.max(8, Math.min(menu.x, (typeof window === 'undefined' ? 9999 : window.innerWidth) - 176)),
            top: Math.max(8, Math.min(menu.y, (typeof window === 'undefined' ? 9999 : window.innerHeight) - 104)),
          }}
        >
          <button
            type="button"
            onClick={() => { setMenu(null); saveImage(); }}
            className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm hover:bg-white/10"
          >
            <Download className="h-4 w-4 shrink-0" /> Save image
          </button>
          <a
            href={currentUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMenu(null)}
            className="flex w-full items-center gap-2.5 border-t border-white/10 px-4 py-3 text-left text-sm hover:bg-white/10"
          >
            <ExternalLink className="h-4 w-4 shrink-0" /> Open original
          </a>
        </div>
      )}
    </div>,
    document.body,
  );
}
