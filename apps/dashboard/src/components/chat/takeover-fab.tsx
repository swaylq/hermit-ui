'use client';

// The Brain-takeover button, as a floating sibling of the voice mic.
//
// It sits in the FabDock rather than the header for the same reason the mic does:
// it's a thing you reach for mid-conversation, with a thumb, and the header on a
// phone is already full. Dragging it drags the whole group — the gesture belongs to
// the dock; this file only owns what a TAP means.
//
// A tap means "hand it over" when idle and "take it back" when the Brain is driving.
// Two meanings on one button is usually a smell, but here they're the two halves of
// one toggle and the button looks unmistakably different in each state — and the
// banner above the composer carries an explicit Release as well, so this is the
// shortcut, not the only way out.

import { useCallback, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { FAB, useFabDock } from '@/components/chat/fab-dock';

export function TakeoverFab({
  active,
  busy,
  onTakeover,
  onRelease,
}: {
  /** The Brain is currently driving this conversation. */
  active: boolean;
  busy: boolean;
  onTakeover: () => void;
  onRelease: () => void;
}) {
  const dock = useFabDock();
  const [hint, setHint] = useState<string | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dock.onDown(e);
      setHint(null);
    },
    [dock],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      dock.onMove(e);
    },
    [dock],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      // A drag is not a tap. Without this, nudging the group aside would hand your
      // conversation to the Brain.
      if (dock.onUp(e)) return;
      if (busy) return;
      if (active) onRelease();
      else onTakeover();
    },
    [dock, busy, active, onRelease, onTakeover],
  );

  return (
    <div className="relative">
      {hint && (
        <div className="absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-full bg-black/75 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
          {hint}
        </div>
      )}
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={() => setHint(active ? '义脑在开车 — 点一下收回' : '义脑接管这段对话')}
        onPointerLeave={() => setHint(null)}
        aria-label={active ? '收回对话（义脑正在接管）' : '让义脑接管这段对话'}
        aria-pressed={active}
        title={active ? '义脑正在开车 — 点一下收回' : '义脑接管 — 它读完这段对话，推断你想达成什么，替你继续。你随时打字也能收回。'}
        className="relative flex items-center justify-center overflow-hidden rounded-full border backdrop-blur-xl cursor-pointer transition-colors"
        style={{
          width: FAB,
          height: FAB,
          borderColor: active ? 'rgba(129,140,248,0.55)' : 'rgba(255,255,255,0.10)',
          background: active ? 'rgba(49,46,129,0.85)' : 'rgba(17,19,25,0.85)',
          boxShadow: active
            ? '0 8px 26px -6px rgba(129,140,248,0.55), 0 4px 12px -2px rgba(0,0,0,0.5)'
            : '0 6px 20px -6px rgba(0,0,0,0.55)',
          transition: dock.dragging ? 'none' : 'box-shadow 0.35s ease, background 0.2s ease',
        }}
      >
        {busy ? (
          <Loader2 className="pointer-events-none h-5 w-5 animate-spin text-white/85" />
        ) : (
          <Bot className="pointer-events-none h-5 w-5" style={{ color: active ? 'rgb(199,210,254)' : 'rgba(255,255,255,0.85)' }} />
        )}
        {/* While the Brain drives, a slow pulse ring — the conversation is moving
            without you touching it, and that should be visible from across the room. */}
        {active && !busy && (
          <span className="pointer-events-none absolute inset-0 animate-pulse rounded-full ring-2 ring-indigo-400/40" />
        )}
      </button>
    </div>
  );
}
