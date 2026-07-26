// Should this event actually reach the phone? Pure decision logic, kept separate
// from delivery so the noise rules are unit-testable without APNs, a DB, or a clock.
//
// Two rules (the third — collapsing — isn't a decision, it's the `apns-collapse-id`
// header every push carries, so a session/cron/machine occupies one lock-screen slot):
//
//   1. VIEWING — the session's read marker moved within the last minute, i.e. you
//      have the chat open right now. Pushing what's already on your screen is the
//      fastest way to make someone disable notifications.
//   2. QUIET HOURS — 23:00–08:00 local, only `blocked` and `host` get through. An
//      agent stopped dead waiting on you, or a machine about to OOM, is worth waking
//      up for; "agent replied" and "cron failed" are not.
//
// Evaluated at DELIVERY time, not enqueue time — which matters for the debounced
// chat events in ./index.ts: opening the session during the debounce window
// retroactively cancels its push.

import type { PushKind } from './types';

/** A read marker this fresh means the session is on screen right now. */
export const VIEWING_WINDOW_MS = 60_000;

/** Quiet hours are [START, 24) ∪ [0, END) in local time. */
export const QUIET_START_HOUR = 23;
export const QUIET_END_HOUR = 8;

/** Kinds that ignore quiet hours — urgent enough to wake someone. */
const ALWAYS: ReadonlySet<PushKind> = new Set<PushKind>(['blocked', 'host']);

export interface SuppressInput {
  kind: PushKind;
  /** Local hour 0–23 in the quiet-hours timezone (see localHour). */
  hour: number;
  /** Delivery-time clock, ms. */
  now: number;
  /** The session's ChatSession.lastReadAt. Undefined for non-session events. */
  lastReadAt?: Date | null;
}

export type SuppressResult = { send: true } | { send: false; reason: 'viewing' | 'quiet-hours' };

export function shouldPush(i: SuppressInput): SuppressResult {
  if (i.lastReadAt && i.now - i.lastReadAt.getTime() < VIEWING_WINDOW_MS) {
    return { send: false, reason: 'viewing' };
  }
  if (isQuietHour(i.hour) && !ALWAYS.has(i.kind)) {
    return { send: false, reason: 'quiet-hours' };
  }
  return { send: true };
}

export function isQuietHour(hour: number): boolean {
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/**
 * Hour-of-day in the quiet-hours timezone. The VPS runs UTC while the human is in
 * UTC+8, so reading the server clock directly would put "quiet hours" in the middle
 * of his afternoon. `Intl` is used rather than an offset constant so DST-observing
 * zones stay correct if this ever moves.
 */
export function localHour(at: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(at);
  // 'en-US' + hour12:false renders midnight as "24" in some ICU versions.
  return Number(h) % 24;
}
