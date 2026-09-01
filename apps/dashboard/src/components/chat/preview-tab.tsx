'use client';

// The live-preview handle — a tab stuck to the right edge of the screen, the way
// a drawer pull is stuck to a drawer. Rendered ONLY while the session has a
// registered live preview (ChatSession.livePreview via the getSession poll), so
// an untouched session shows nothing new at all.
//
// It used to be a draggable circle floating wherever it was last dropped. Being
// dockable to any of a thousand positions turned out to say nothing about what
// it did; being welded to the edge the panel comes out of says the whole thing
// before it is even pressed. Pressing it pulls that panel open (preview-panel.tsx
// animates the width on desktop, the slide on a phone), and the tab tucks itself
// off the right edge as the panel arrives — the drawer and its handle cannot both
// occupy the same edge, and once the drawer is open its own ✕ / Esc / ⌘\ close it.
//
// Half-tucked on purpose: the rounded left corners and the flat right edge read
// as "there is more of this off-screen", which is what makes a tab a tab.

import { useState } from 'react';
import { AppWindow } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Display token for the toggle shortcut, per platform. */
function shortcutLabel(): string {
  if (typeof navigator === 'undefined') return '⌘\\';
  const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);
  return mac ? '⌘\\' : 'Ctrl+\\';
}

export function PreviewTab({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const combo = shortcutLabel();
  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      tabIndex={open ? -1 : 0}
      aria-hidden={open}
      aria-label={`打开实时预览面板（${combo}）`}
      className={cn(
        // Above the composer (z-50), below the panel itself (90) and dialogs
        // (100+) — so on a phone, where the panel is a full-screen layer, the
        // panel simply covers it.
        'preview-edge-tab group fixed right-0 top-1/2 z-[70] -translate-y-1/2',
        // 34px, not 30: half of a handle flush against the screen edge is
        // already off-screen, and `hover:w-[34px]` never fires on a touch
        // device — so the widened state has to be the resting one.
        'flex h-16 w-[34px] items-center justify-center',
        // Flat against the edge, rounded away from it. No right border: the
        // screen edge is that side.
        'rounded-l-2xl border border-r-0 border-white/10 bg-[#111319]/85 backdrop-blur-xl',
        'cursor-pointer transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
        'hover:w-[38px] hover:border-white/25 hover:bg-[#161b22]/90',
        // Out of the way the moment the drawer starts arriving.
        open && 'pointer-events-none translate-x-full opacity-0',
      )}
      style={{ boxShadow: '-6px 0 20px -6px rgba(0,0,0,0.55)' }}
    >
      {/* Hover hint, to the LEFT — there is no room on the other side. */}
      {hover && !open && (
        <span className="pointer-events-none absolute right-full top-1/2 mr-2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-black/75 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
          打开预览
          <kbd className="rounded bg-white/15 px-1 font-mono text-[10px] leading-4">{combo}</kbd>
        </span>
      )}
      <AppWindow className="pointer-events-none h-[18px] w-[18px] text-white/85 transition-colors group-hover:text-white" />
      {/* "live" dot — the preview is mounted and serving. */}
      <span className="pointer-events-none absolute right-[5px] top-[9px] size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]" />
    </button>
  );
}
