'use client';

// Per-session "last read" tracking, client-side only (localStorage) — no DB
// column, no gateway round-trip. A session counts as "read" while the user has
// it open in the chat view; everything else compares the session's
// `lastMessageAt` against the stored read stamp to decide if there's finished
// work the user hasn't seen yet (the red "unread" dot — see session-status.ts).

import { useCallback, useEffect, useState } from 'react';

const key = (id: string) => `hermit:read:${id}`;

// Stamp a session read = now. Called by the open chat pane on view + on each new
// message, so the session it's showing never lingers as "unread". Fires a
// `hermit:read` event so other mounted views (sidebar / detail sheet) drop the
// red dot immediately instead of waiting for their next refetch.
export function markSessionRead(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key(sessionId), String(Date.now()));
    window.dispatchEvent(new Event('hermit:read'));
  } catch {
    // private mode / quota — non-fatal; the dot just won't clear.
  }
}

/**
 * Returns `isUnread(sessionId, lastMessageAt)`. Re-renders the caller when any
 * session is marked read (same tab via `hermit:read`, other tabs via `storage`).
 * Returns false until mounted so the dot's colour can't cause an SSR/hydration
 * mismatch.
 */
export function useUnread(): (sessionId: string, lastMessageAt: Date | string | null | undefined) => boolean {
  const [mounted, setMounted] = useState(false);
  const [, force] = useState(0);
  useEffect(() => {
    setMounted(true);
    const bump = () => force((n) => n + 1);
    window.addEventListener('hermit:read', bump);
    window.addEventListener('storage', bump);
    return () => {
      window.removeEventListener('hermit:read', bump);
      window.removeEventListener('storage', bump);
    };
  }, []);
  return useCallback(
    (sessionId, lastMessageAt) => {
      if (!mounted || !lastMessageAt) return false;
      const read = Number(localStorage.getItem(key(sessionId)) || 0);
      return new Date(lastMessageAt).getTime() > read;
    },
    [mounted],
  );
}
