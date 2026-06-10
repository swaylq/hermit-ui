'use client';

// Per-session optimistic "working" signal, client-side only — no DB, no gateway
// round-trip. When the web user sends a message we KNOW a turn is about to run,
// but the gateway derives a session's `state` from an ~8s pane snapshot and the
// sidebar only polls listSessions every 5s, so the status dot would otherwise lag
// 8–13s before turning yellow. markSessionWorking() stamps "the user just acted on
// this session = now"; a reader shows 'working' until the gateway's own snapshot
// catches up *past* that stamp (`snapshotAt > stamp`), then the real `state` takes
// over. Same set-on-action → reconcile-when-snapshot-passes shape as the chat
// header's isWaitingAssistant/turnSettled pair, and the same localStorage +
// window-event delivery as session-read.ts so the sidebar (a different component
// tree) flips instantly without prop-drilling.

import { useCallback, useEffect, useState } from 'react';

const key = (id: string) => `hermit:live:${id}`;
// Hard cap so a stamp can never pin a dot yellow forever if a snapshot somehow
// never lands after the send (an errored/lost turn). Mirrors the chat header's
// 90s turn backstop; the snapshotAt reconcile clears it far sooner in practice.
const TTL_MS = 90_000;

// Stamp "the user just sent to this session = now" and fire `hermit:live` so other
// mounted views (the sidebar) flip the dot to working immediately.
export function markSessionWorking(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key(sessionId), String(Date.now()));
    window.dispatchEvent(new Event('hermit:live'));
  } catch {
    // private mode / quota — non-fatal; the dot just falls back to the poll.
  }
}

/**
 * Returns `liveWorkingSince(sessionId)` → the epoch-ms of the last local send to
 * that session while still within TTL, else null. The caller reconciles it against
 * the session's own `snapshotAt`: render optimistic 'working' only while the
 * gateway has NOT snapshotted the pane after the send (`snapshotAt < stamp`). Once
 * a fresh snapshot lands, the real `state` drives the dot. Re-renders the caller on
 * `hermit:live` (same tab) + `storage` (cross-tab). Returns null until mounted to
 * avoid an SSR/hydration mismatch.
 */
export function useLiveWorking(): (sessionId: string) => number | null {
  const [mounted, setMounted] = useState(false);
  const [, force] = useState(0);
  useEffect(() => {
    setMounted(true);
    const bump = () => force((n) => n + 1);
    window.addEventListener('hermit:live', bump);
    window.addEventListener('storage', bump);
    return () => {
      window.removeEventListener('hermit:live', bump);
      window.removeEventListener('storage', bump);
    };
  }, []);
  return useCallback(
    (sessionId) => {
      if (!mounted) return null;
      const at = Number(localStorage.getItem(key(sessionId)) || 0);
      if (!at || Date.now() - at > TTL_MS) return null;
      return at;
    },
    [mounted],
  );
}
