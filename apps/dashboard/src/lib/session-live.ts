'use client';

// Two client-side, per-session signals that let one view tell the others what it
// can see and they cannot. No DB, no gateway round-trip; localStorage + a window
// event, the same delivery session-read.ts uses, so views in different component
// trees (and different tabs) flip together without prop-drilling.
//
//   1. markSessionWorking / useLiveWorking — "you just pressed send here", a
//      GUESS, reconciled away by the next gateway snapshot.
//   2. publishSessionStatus / useLiveStatus — what the open chat page actually
//      READS for its session. Not a guess, and it outranks (1). See its own note
//      further down.
//
// ── 1 ───────────────────────────────────────────────────────────────────────
//
// When the web user sends a message we KNOW a turn is about to run,
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
  const mounted = useLiveChannel();
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

// Re-render the caller whenever anything on this channel changes, in this tab
// (`hermit:live`) or another (`storage`). Returns false until mounted, so a
// reader can hold its SSR output and avoid a hydration mismatch. Shared by both
// readers below — the plumbing was identical, and two copies of "which events
// mean the channel moved" is exactly how the two dots drift apart.
function useLiveChannel(): boolean {
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
  return mounted;
}

// ── 2. The open session's status, as the chat page reads it ─────────────────
//
// The stamp above is a GUESS ("you just pressed send, so something must be
// happening"). This is not: the chat page has the session's message stream and
// its pending-interaction blocks loaded, so for the one session you have open it
// knows things no 8s pane snapshot can tell the sidebar —
//
//   - a turn that started anywhere but this composer (a cron, another device,
//     the agent waking itself) is visible here the moment its user row lands,
//     ~13s before the gateway snapshot + the 5s poll agree;
//   - a turn parked on a permission prompt is 'needs you', which the sidebar
//     cannot derive at all: nothing in the listSessions payload says so.
//
// So the chat page publishes what it sees, the sidebar prefers it over its own
// guess, and both then run sessionStatusView on the same inputs. That is the
// whole fix for "the header and the sidebar disagree about the chat I am
// looking at": not a second opinion, the same one.
//
// 'idle' is a real value, not the absence of one — it means "the chat page
// looked and there is no turn", which must be able to OVERRULE a stale send
// stamp. Absent (null) means only "no chat page is open on this session".
export type LiveStatus = 'working' | 'needs-you' | 'idle';

const statusKey = (id: string) => `hermit:status:${id}`;
// Long enough to survive a few missed refreshes, short enough that a tab killed
// mid-turn (no unmount, no cleanup) stops pinning a dot within a few seconds.
const STATUS_TTL_MS = 20_000;
/** How often the open chat page re-stamps an unchanged status. Well under the TTL. */
export const STATUS_REFRESH_MS = 5_000;

/**
 * Publish what the open chat page currently sees for `sessionId`. Safe to call
 * on a timer: the write is cheap and the wake-up event fires only when the value
 * actually CHANGED, so the periodic refresh costs the sidebar no re-renders.
 */
export function publishSessionStatus(sessionId: string, status: LiveStatus): void {
  if (typeof window === 'undefined' || !sessionId) return;
  try {
    const prev = localStorage.getItem(statusKey(sessionId));
    localStorage.setItem(statusKey(sessionId), `${status}|${Date.now()}`);
    if (prev?.split('|')[0] !== status) window.dispatchEvent(new Event('hermit:live'));
  } catch {
    // private mode / quota — non-fatal; the sidebar falls back to its own guess.
  }
}

/** Stop speaking for this session — it is no longer open anywhere in this tab. */
export function clearSessionStatus(sessionId: string): void {
  if (typeof window === 'undefined' || !sessionId) return;
  try {
    if (localStorage.getItem(statusKey(sessionId)) === null) return;
    localStorage.removeItem(statusKey(sessionId));
    window.dispatchEvent(new Event('hermit:live'));
  } catch {
    // ignore — see above.
  }
}

/**
 * Decode one stored report, or null if there isn't a usable one. Split out and
 * exported so the two ways this goes wrong are testable without a DOM: an entry
 * older than the TTL (the chat page went away without cleaning up — a closed
 * tab, a crash) and an entry this build doesn't understand (an older or newer
 * dashboard left it behind; localStorage outlives a deploy).
 */
export function parseLiveStatus(raw: string | null, now: number): LiveStatus | null {
  if (!raw) return null;
  const [status, at] = raw.split('|');
  const stamped = Number(at);
  if (!stamped || now - stamped > STATUS_TTL_MS) return null;
  return status === 'working' || status === 'needs-you' || status === 'idle' ? status : null;
}

/**
 * Returns `liveStatus(sessionId)` → what the open chat page last reported for
 * that session, or null if no chat page is open on it (or the last report has
 * gone stale). Re-renders the caller when the channel moves.
 */
export function useLiveStatus(): (sessionId: string) => LiveStatus | null {
  const mounted = useLiveChannel();
  return useCallback(
    (sessionId) => (mounted ? parseLiveStatus(localStorage.getItem(statusKey(sessionId)), Date.now()) : null),
    [mounted],
  );
}
