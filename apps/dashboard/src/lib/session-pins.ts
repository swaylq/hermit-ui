'use client';

// Per-session "pin to top" flags, client-side only (localStorage) — no DB, no
// gateway round-trip. Pinned chats sort above the rest in the sidebar recents
// list. Stored as one JSON array of session ids under `hermit:pins` (array order
// = most-recently-pinned first). Mirrors session-read.ts's localStorage +
// window-event pattern so every mounted view re-renders the instant a pin toggles
// (same tab via `hermit:pins`, other tabs via the native `storage` event).

import { useEffect, useState } from 'react';

const KEY = 'hermit:pins';

function read(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// Pin/unpin a session and fire `hermit:pins` so the sidebar reorders immediately.
export function togglePin(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const cur = read();
    const next = cur.includes(sessionId)
      ? cur.filter((id) => id !== sessionId)
      : [sessionId, ...cur];
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new Event('hermit:pins'));
  } catch {
    // private mode / quota — non-fatal; the pin just won't persist.
  }
}

/**
 * Returns the set of pinned session ids, re-rendering the caller whenever a pin
 * toggles. Empty on the first render (and during SSR) so the dot/order can't cause
 * a hydration mismatch; the real set lands in a post-mount effect.
 */
export function usePins(): Set<string> {
  const [pins, setPins] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const sync = () => setPins(new Set(read()));
    sync();
    window.addEventListener('hermit:pins', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('hermit:pins', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return pins;
}
