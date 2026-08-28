'use client';

// A local copy of the sidebar's session list, so switching machines paints the
// list immediately instead of waiting on the network.
//
// The sidebar is blocked on `chat.listSessions`, which is the biggest query the
// app makes: 90 KB / ~73 ms for 124 sessions, measured against the VPS on a good
// desktop connection. A machine switch is a full document navigation, so the
// React Query cache starts empty every time and that round trip is on the
// critical path — ~200 ms to the first row here, and far worse on a phone over
// cellular, which is where the complaint came from.
//
// Kept per machine, for the same reason lib/last-session.ts and lib/chat-filter.ts
// are: the rows belong to one machine and must never be shown under another.
//
// This is a PLACEHOLDER, never a source of truth. It is handed to React Query as
// initial paint only; the real fetch is already in flight and replaces it. Stale
// rows therefore live for one round trip — a session deleted elsewhere may flash
// once, and clicking a dead one is already handled (the chat page re-lands when a
// session id doesn't resolve).
//
// localStorage rather than IndexedDB because it has to be readable SYNCHRONOUSLY
// during the first render; an async store cannot seed a first paint.

import { getActiveEntry } from '@/lib/keyring';

const PREFIX = 'hermit:sessions:';

// The snapshot tick rewrites per-session runtime fields every few seconds, so the
// query data legitimately changes far more often than the sidebar's appearance
// does. Writing 90 KB on every one of those is real main-thread work on a phone
// for no benefit, so writes are throttled; a cache that is a few seconds behind
// costs nothing, since it is only ever the first frame before the fetch lands.
const MIN_WRITE_MS = 20_000;
let lastWriteAt = 0;

function keyFor(): string | null {
  const id = getActiveEntry()?.id;
  return id ? `${PREFIX}${id}` : null;
}

/** The active machine's last known session list, or undefined if there isn't one. */
export function readCachedSessions<T>(): T[] | undefined {
  if (typeof window === 'undefined') return undefined;
  const k = keyFor();
  if (!k) return undefined;
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return undefined;
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length > 0 ? (v as T[]) : undefined;
  } catch {
    return undefined;
  }
}

// `force` skips the throttle: an optimistic delete removes rows from the query
// cache instantly, and without a forced write the snapshot would still hold the
// dead row — flashing it on the next full reload's first paint.
export function writeCachedSessions(rows: unknown[], force = false): void {
  if (typeof window === 'undefined' || !Array.isArray(rows)) return;
  const now = Date.now();
  if (!force && now - lastWriteAt < MIN_WRITE_MS) return;
  const k = keyFor();
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify(rows));
    lastWriteAt = now;
  } catch {
    // Quota — most likely another machine's copy filling the origin. Drop every
    // cached list and take the slow first paint rather than half-write this one.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
      }
    } catch { /* nothing more to try */ }
  }
}
