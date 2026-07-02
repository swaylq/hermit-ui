'use client';

// Global keyboard shortcuts — ACTIVE ONLY IN THE INSTALLED PWA (isStandalone).
// ⌘K focus search · ⌘⇧N new chat · ⌘1-6 navigate · ? open Help (→ /help).
// Listener-only (renders nothing); mounted once in providers.

import { useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { SHORTCUTS, isStandalone } from '@/lib/shortcuts';

function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

export function KeyboardShortcuts() {
  const router = useRouter();

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (!isStandalone()) return;
      const typing = isTypingTarget(e.target);
      // ⌘K — focus the sidebar search (whichever the current route renders).
      if (e.metaKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const input = document.querySelector('[data-sidebar-search]') as HTMLInputElement | null;
        input?.focus();
        input?.select();
        return;
      }
      // ? — jump to the Help page (not while typing). NB: ⌘/ is taken — the chat
      // page uses it to focus the composer — so ? is the sole Help trigger here.
      if (!typing && e.key === '?') {
        e.preventDefault();
        router.push('/help');
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
    [router],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return null;
}
