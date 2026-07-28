'use client';

// The floating button dock on the chat page. Currently it holds one thing — the
// voice mic — since Brain-takeover moved into the suggestion row above the composer.
//
// It stays a dock rather than collapsing back into the mic because the split is the
// useful part: the dock owns geometry (position, clamping, persistence, drag) and the
// button owns what a press MEANS. The mic's press is a 180ms race between record /
// drag / ask-for-permission with real teeth in it, and that logic is much easier to
// keep correct when it isn't also doing arithmetic on viewport edges.
//
// Buttons stack vertically if more are ever added: the mic expands sideways into a
// capsule while recording, so a horizontal row would end up underneath it.

import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** Idle circle diameter (px) for every button in the dock. */
export const FAB = 44;
/** Vertical gap between stacked buttons. */
const GAP = 8;
/** Early move beyond this many px = a drag, not a press. */
const DRAG_PX = 8;
/** A move within this window counts as "early" — after it, the press has committed. */
export const HOLD_MS = 180;
const POS_KEY = 'hermit:voice-mic-pos'; // unchanged: an existing position carries over
const SPRING = 'cubic-bezier(0.34, 1.35, 0.5, 1)';

/**
 * Clamp to the viewport. `height` is the whole stack, so dragging the group to the
 * bottom edge doesn't push the lower button off-screen.
 */
function clampPos(x: number, y: number, height: number) {
  const maxX = Math.max(8, window.innerWidth - FAB - 8);
  const maxY = Math.max(8, window.innerHeight - height - 8);
  return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
}

function defaultPos(height: number) {
  return clampPos(window.innerWidth - FAB - 20, window.innerHeight - height - 120, height);
}

function loadPos(height: number): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof p.x === 'number' && typeof p.y === 'number') return clampPos(p.x, p.y, height);
  } catch {
    /* private mode / bad json */
  }
  return null;
}

interface DockApi {
  /** Is the group being dragged right now? Buttons use it to kill transitions. */
  dragging: boolean;
  /** The dock's left edge, so a button that expands can decide which way to grow. */
  x: number;
  /** Start tracking a press. Call from the button's own onPointerDown. */
  onDown: (e: ReactPointerEvent<HTMLElement>) => void;
  /**
   * Track movement. Returns true once the gesture has become a DRAG — the moment a
   * button should abandon whatever it thought the press was (the mic cancels its
   * recording here).
   */
  onMove: (e: ReactPointerEvent<HTMLElement>) => boolean;
  /** Finish. Returns true if this gesture was a drag, i.e. NOT a press to act on. */
  onUp: (e: ReactPointerEvent<HTMLElement>) => boolean;
}

const DockContext = createContext<DockApi | null>(null);

export function useFabDock(): DockApi {
  const ctx = useContext(DockContext);
  if (!ctx) throw new Error('useFabDock must be used inside <FabDock>');
  return ctx;
}

export function FabDock({ count, children }: { count: number; children: React.ReactNode }) {
  // Total stack height drives clamping; it changes when the takeover button appears
  // or disappears, so it's derived from the live button count rather than a constant.
  const height = count * FAB + Math.max(0, count - 1) * GAP;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const g = useRef({ down: false, drag: false, px: 0, py: 0, fx: 0, fy: 0, at: 0 });

  // Mount gate: there is no window on the server, so the first client render has to
  // agree with it (nothing) and the position arrives on the tick after. Empty deps —
  // this runs exactly once.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount gate reading window/localStorage
    setPos(loadPos(height) ?? defaultPos(height));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount gate; later height changes go through the render-time clamp below
  }, []);

  // A resize only needs to trigger a re-render; the clamping itself happens below.
  // Keeping it out of state is what lets `height` change (a button appearing or
  // disappearing) without an effect that writes state on every change.
  const [, bumpViewport] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const onResize = () => bumpViewport();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const gg = g.current;
      gg.down = true;
      gg.drag = false;
      gg.at = Date.now();
      gg.px = e.clientX;
      gg.py = e.clientY;
      gg.fx = pos?.x ?? 0;
      gg.fy = pos?.y ?? 0;
    },
    [pos],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const gg = g.current;
      if (!gg.down) return false;
      const dx = e.clientX - gg.px;
      const dy = e.clientY - gg.py;
      // Only an EARLY move becomes a drag. Past HOLD_MS the press has committed to
      // its own meaning (the mic is already recording), and a wandering finger must
      // not yank the group out from under it.
      if (!gg.drag && Math.hypot(dx, dy) > DRAG_PX && Date.now() - gg.at < HOLD_MS) {
        gg.drag = true;
        setDragging(true);
      }
      if (gg.drag) setPos(clampPos(gg.fx + dx, gg.fy + dy, height));
      return gg.drag;
    },
    [height],
  );

  const onUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const gg = g.current;
      if (!gg.down) return false;
      gg.down = false;
      if (!gg.drag) return false;
      gg.drag = false;
      const np = clampPos(gg.fx + (e.clientX - gg.px), gg.fy + (e.clientY - gg.py), height);
      setPos(np);
      setDragging(false);
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(np));
      } catch {
        /* private mode */
      }
      return true;
    },
    [height],
  );

  if (!pos) return null;
  // Clamp at RENDER time, not in an effect: the correct position is a pure function
  // of the stored point, the current stack height and the viewport, so deriving it
  // keeps a button appearing/disappearing from needing a state write.
  const view = clampPos(pos.x, pos.y, height);

  return (
    <DockContext.Provider value={{ dragging, x: view.x, onDown, onMove, onUp }}>
      <div
        className="fixed z-40 flex touch-none select-none flex-col items-end"
        style={{
          left: view.x,
          top: view.y,
          gap: GAP,
          transition: dragging ? 'none' : `left 0.42s ${SPRING}, top 0.42s ${SPRING}`,
        }}
      >
        {children}
      </div>
    </DockContext.Provider>
  );
}
