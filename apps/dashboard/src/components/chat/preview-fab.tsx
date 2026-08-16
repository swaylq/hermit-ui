'use client';

// The live-preview FAB — second button in the FabDock, under the mic. Rendered
// ONLY while the session has a registered live preview (ChatSession.livePreview
// via the getSession poll), so an untouched session shows nothing new at all.
//
// Gesture-wise it is the simple case the dock was built for: dock.onDown/onMove
// track the drag race, and a press only counts when onUp says the gesture never
// became a drag (same contract as VoiceMic, minus the long-press semantics).
//
// Hovering shows a self-drawn hint bubble (VoiceMic's hint style) carrying the
// ⌘\ / Ctrl+\ shortcut — no native title, so the two never double up.

import { useState } from 'react';
import { AppWindow } from 'lucide-react';
import { FAB, useFabDock } from './fab-dock';
import { cn } from '@/lib/utils';

/** Display token for the toggle shortcut, per platform. */
function shortcutLabel(): string {
  if (typeof navigator === 'undefined') return '⌘\\';
  const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);
  return mac ? '⌘\\' : 'Ctrl+\\';
}

export function PreviewFab({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const dock = useFabDock();
  const [hover, setHover] = useState(false);
  const combo = shortcutLabel();
  return (
    <button
      type="button"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dock.onDown(e);
      }}
      onPointerMove={dock.onMove}
      onPointerUp={(e) => {
        if (!dock.onUp(e)) onToggle();
      }}
      onPointerCancel={dock.onUp}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      aria-label={`${open ? '关闭' : '打开'}实时预览面板（${combo}；可拖动移位）`}
      className={cn(
        // Same dark-glass family as the mic FAB. Open state is expressed with
        // brightness (border + icon step up), not a color shift — the emerald
        // dot is the only chroma here, and it means "registration live".
        'relative flex items-center justify-center rounded-full border backdrop-blur-xl cursor-pointer transition-colors',
        open ? 'border-white/30 bg-[#161b22]/90' : 'border-white/10 bg-[#111319]/85 hover:border-white/25',
      )}
      style={{ width: FAB, height: FAB, boxShadow: '0 6px 20px -6px rgba(0,0,0,0.55)' }}
    >
      {/* Hover hint — VoiceMic's bubble idiom, with the shortcut as a kbd chip. */}
      {hover && !dock.dragging && (
        <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-black/75 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
          {open ? '关闭预览' : '打开预览'}
          <kbd className="rounded bg-white/15 px-1 font-mono text-[10px] leading-4">{combo}</kbd>
        </span>
      )}
      <AppWindow className={cn('pointer-events-none h-5 w-5 transition-colors', open ? 'text-white' : 'text-white/85')} />
      {/* "live" dot — the preview is mounted and serving */}
      <span className="pointer-events-none absolute right-[7px] top-[7px] size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]" />
    </button>
  );
}
