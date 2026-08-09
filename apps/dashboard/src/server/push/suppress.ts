// Should this event actually reach the phone? Pure decision logic, kept separate
// from delivery so the noise rules are unit-testable without APNs, a DB, or a clock.
//
// One rule (collapsing isn't a decision — it's the collapse key every push carries,
// so a session/cron/machine occupies one lock-screen slot):
//
//   VIEWING — the session's read marker moved within the last minute, i.e. you have
//   the chat open right now. Pushing what's already on your screen is the fastest
//   way to make someone disable notifications.
//
// Evaluated at DELIVERY time, not enqueue time — which matters for the debounced
// chat events in ./index.ts: opening the session during the debounce window
// retroactively cancels its push.
//
// There used to be a second rule here, QUIET HOURS: 23:00–08:00 local, everything
// but `blocked` / `host` / `stall` held back. It was removed — silently dropping a
// notification because of the clock means the one you needed at 01:00 never
// arrives and nothing anywhere says why. Time-of-day filtering belongs to the
// phone, which already does it properly: iOS Focus modes are per-person,
// per-schedule, and visible to the person they affect. The urgency signal this
// file still exports is what lets those modes make the decision — see below.

import type { PushKind } from './types';

/** A read marker this fresh means the session is on screen right now. */
export const VIEWING_WINDOW_MS = 60_000;

/**
 * Kinds urgent enough to pierce a Focus mode — Bark's `timeSensitive` level, Web
 * Push's `Urgency: high`. An agent stopped dead waiting on you, a machine about to
 * OOM, or a question of yours that nothing answered are worth interrupting for;
 * "agent replied" and "cron failed" are not.
 *
 * This is now the ONLY thing the urgency judgement drives. Nothing here suppresses
 * a push: an ordinary-urgency notification is still delivered, and iOS decides
 * whether to make a sound. That split is the point — we say how important it is,
 * the phone says whether now is a good time.
 */
export const URGENT_KINDS: ReadonlySet<PushKind> = new Set<PushKind>(['blocked', 'host', 'stall']);

export function isUrgentKind(kind: PushKind): boolean {
  return URGENT_KINDS.has(kind);
}

// `kind` deliberately does NOT appear here any more. It was only ever read by the
// quiet-hours rule; leaving it in the input would imply the event's kind still
// affects whether it is delivered, which is exactly what stopped being true.
export interface SuppressInput {
  /** Delivery-time clock, ms. */
  now: number;
  /** The session's ChatSession.lastReadAt. Undefined for non-session events. */
  lastReadAt?: Date | null;
}

export type SuppressResult = { send: true } | { send: false; reason: 'viewing' };

export function shouldPush(i: SuppressInput): SuppressResult {
  if (i.lastReadAt && i.now - i.lastReadAt.getTime() < VIEWING_WINDOW_MS) {
    return { send: false, reason: 'viewing' };
  }
  return { send: true };
}
