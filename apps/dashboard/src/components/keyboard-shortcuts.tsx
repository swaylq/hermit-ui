'use client';

// Global keyboard shortcuts — ACTIVE ONLY IN THE INSTALLED PWA (isStandalone).
// ⌘K focus search · ⌘⇧N new chat · ⌘1-6 navigate · ? (or ⌘/) shortcuts overlay ·
// Esc close. Mounted once in providers; the listener lives for the app's lifetime.
// The ? overlay + the Settings → Help tab both render from lib/shortcuts SHORTCUTS.

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { SHORTCUTS, isStandalone, type ShortcutGroup } from '@/lib/shortcuts';

function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

export function KeyboardShortcuts() {
  const router = useRouter();
  const [overlay, setOverlay] = useState(false);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (!isStandalone()) return;
      if (e.key === 'Escape') {
        if (overlay) setOverlay(false); // let other modals handle their own Esc
        return;
      }
      const typing = isTypingTarget(e.target);
      // ⌘K — focus the sidebar search (whichever the current route renders).
      if (e.metaKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const input = document.querySelector('[data-sidebar-search]') as HTMLInputElement | null;
        input?.focus();
        input?.select();
        return;
      }
      // ? / ⌘/ — toggle the shortcuts overlay (? only when not typing).
      if ((!typing && e.key === '?') || (e.metaKey && e.key === '/')) {
        e.preventDefault();
        setOverlay((v) => !v);
        return;
      }
      if (!e.metaKey) return;
      // ⌘⇧N — new chat.
      if (e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        window.location.href = '/chat?new=1';
        return;
      }
      // ⌘1–6 — navigate to a top-level section.
      const nav = SHORTCUTS.find((s) => s.href && s.keys[0] === '⌘' && s.keys[1] === e.key);
      if (nav?.href) {
        e.preventDefault();
        router.push(nav.href);
      }
    },
    [overlay, router],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return overlay ? <ShortcutsOverlay onClose={() => setOverlay(false)} /> : null;
}

const GROUPS: ShortcutGroup[] = ['Navigation', 'Actions', 'General'];

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-medium">Keyboard shortcuts</span>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted cursor-pointer" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-3">
          {GROUPS.map((g) => (
            <div key={g}>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g}</div>
              <div className="space-y-1">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-foreground/90">{s.label}</span>
                    <ShortcutKeys keys={s.keys} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          Active in the installed app. Full guide in Settings → Help.
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ShortcutKeys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 gap-1">
      {keys.map((k, i) => (
        <kbd key={i} className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground/80">
          {k}
        </kbd>
      ))}
    </span>
  );
}
