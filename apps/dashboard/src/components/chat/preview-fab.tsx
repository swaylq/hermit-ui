'use client';

// The live-preview FAB — second button in the FabDock, under the mic. Rendered
// ONLY while the session has a registered live preview (ChatSession.livePreview
// via the getSession poll), so an untouched session shows nothing new at all.
//
// Gesture-wise it is the simple case the dock was built for: dock.onDown/onMove
// track the drag race, and a press only counts when onUp says the gesture never
// became a drag (same contract as VoiceMic, minus the long-press semantics).

import { AppWindow } from 'lucide-react';
import { FAB, useFabDock } from './fab-dock';
import { cn } from '@/lib/utils';

export function PreviewFab({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const dock = useFabDock();
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
      aria-label={open ? '关闭实时预览面板' : '打开实时预览面板（可拖动移位）'}
      title={open ? '关闭实时预览' : '打开实时预览（agent 挂载的页面；可拖动移位）'}
      className={cn(
        'relative flex items-center justify-center rounded-full border backdrop-blur-xl cursor-pointer transition-colors',
        open ? 'border-sky-400/60 bg-sky-950/85' : 'border-white/10 bg-[#111319]/85 hover:border-white/25',
      )}
      style={{ width: FAB, height: FAB, boxShadow: '0 6px 20px -6px rgba(0,0,0,0.55)' }}
    >
      <AppWindow className={cn('pointer-events-none h-5 w-5', open ? 'text-sky-300' : 'text-white/85')} />
      {/* "live" dot — the preview is mounted and serving */}
      <span className="pointer-events-none absolute right-[7px] top-[7px] h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />
    </button>
  );
}
