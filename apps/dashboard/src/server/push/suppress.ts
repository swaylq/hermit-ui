// Should this event actually reach the phone, and is now the moment? Pure decision
// logic, kept separate from delivery so the noise rules are unit-testable without
// APNs, a DB, or a clock.
//
// Two rules (collapsing isn't a decision — it's the collapse key every push carries,
// so a session/cron/machine occupies one lock-screen slot):
//
//   VIEWING — the session's read marker moved within the last minute, i.e. you have
//   the chat open right now. Pushing what's already on your screen is the fastest
//   way to make someone disable notifications. Answered by `shouldPush`.
//
//   MID-TURN — the agent is still working. A notification is worth having when the
//   task is DONE and the agent has answered you; the things it says on the way
//   there are thinking out loud. Answered by `turnStillRunning`.
//
// Both are evaluated at DELIVERY time, not enqueue time — which matters for the
// debounced chat events in ./index.ts: opening the session during the debounce
// window retroactively cancels its push, and a turn that is still going postpones
// it.
//
// There used to be a second rule here, QUIET HOURS: 23:00–08:00 local, everything
// but `blocked` / `host` / `stall` held back. It was removed — silently dropping a
// notification because of the clock means the one you needed at 01:00 never
// arrives and nothing anywhere says why. Time-of-day filtering belongs to the
// phone, which already does it properly: iOS Focus modes are per-person,
// per-schedule, and visible to the person they affect. The urgency signal this
// file still exports is what lets those modes make the decision — see below.

// Imported, where STATE_TRUSTED_MS below is deliberately duplicated, because the
// two are different kinds of thing: that constant is a JUDGEMENT this file is
// free to move without asking the browser, while this is the SHAPE of the
// `activity` Json column, and two readers of one column disagreeing about its
// shape is a bug in both.
import { backgroundOutstanding } from '@/lib/session-status';
import type { PushKind } from './types';

// Re-exported so the delivery side reads the same fact through the same door as
// the rule that held the notification back.
export { backgroundOutstanding };

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
// affects whether it is delivered, which is exactly what stopped being true. The
// mid-turn rule below does apply to one kind only — but it is a separate function
// that only the chat debounce calls, precisely so that this one keeps its promise:
// nothing here decides differently because of what an event is about.
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

/**
 * How long a session's `state` is still evidence about what it is doing.
 *
 * The gateway snapshots every 8s, so this is ~5 missed ticks — the same number,
 * and for the same reason, as the dashboard's SNAPSHOT_STALE_MS: nothing else in
 * the pipeline ever clears a `state` of 'working', so past this it is a memory
 * rather than an observation. Not imported from lib/session-status because that
 * file is the browser's copy of this judgement and this one runs on the server's
 * own clock against the server's own column; sharing the constant would couple a
 * push decision to a rendering decision that is free to move.
 */
export const STATE_TRUSTED_MS = 45_000;

/**
 * How long a hold may rest on background work ALONE before the notification goes
 * out anyway.
 *
 * `state === 'working'` is held without limit, and the comment below says why. A
 * background task cannot have the same promise, because nothing guarantees it
 * ever ends: an agent that leaves `npm run dev` running in the background has an
 * outstanding task for the rest of the session's life, and an unbounded rule
 * would make that session silent for ever — no lock screen, no sound, for any
 * reply, indefinitely. Past this the task is treated as a resident process
 * rather than a step in the answer, and the last thing the agent said is
 * delivered.
 *
 * 30 minutes is chosen to match HOLD_REPORT_MS in ./index.ts, so the release and
 * the log line explaining it happen together.
 */
export const BACKGROUND_HOLD_MAX_MS = 30 * 60_000;

export interface TurnInput {
  /** ChatSession.state as the gateway last wrote it. */
  state?: string | null;
  /** ChatSession.snapshotAt — when it wrote it. */
  snapshotAt?: Date | null;
  /**
   * ChatSession.activity — the gateway's opaque Json description of what the
   * session is doing. Read for one fact only: whether work it started is still
   * running after the turn ended. See backgroundOutstanding.
   */
  activity?: unknown;
  /**
   * How long this notification has been held already, ms. Only the background
   * rule reads it; omitted means "not held yet", which is also what every caller
   * that does not hold passes.
   */
  heldMs?: number;
  /** Delivery-time clock, ms. Server-side, so the same clock that wrote snapshotAt. */
  now: number;
}

/**
 * Is the agent still mid-turn, on evidence fresh enough to act on?
 *
 * sway: "agent 要当前任务都结束回复用户了再推送消息，中间过程不用推送". A trailing
 * debounce alone cannot do that. It assumes a turn is a burst of messages, which
 * is true of a two-line answer and false of the work this fleet actually does: an
 * agent on a long task says "let me look at X", then sits in a tool for two
 * minutes. The quiet the debounce is waiting for arrives in the MIDDLE, and the
 * preamble goes to the lock screen — then the next one does, and the next.
 *
 * So the debounce becomes a floor rather than the whole rule, and the flush waits
 * for this to go false. `state` is trustworthy enough to gate on since the
 * claude-sdk runtime started reading the CLI's own `session_state_changed` frame
 * (runtime/claude-sdk-activity.ts) — it is the turn boundary itself, not a guess
 * from output that stopped moving.
 *
 * Two ways this says "no" that are not "the turn ended", both deliberate:
 *
 *   - no snapshot at all, or one older than STATE_TRUSTED_MS. A gateway that has
 *     stopped reporting would otherwise hold the notification for ever on the
 *     strength of the last thing it happened to say.
 *   - no session row (`state` undefined). Nothing to wait for.
 *
 * And one way it says "yes" that `state` alone cannot see, added 2026-08-23:
 * backgrounding a Bash or a subagent ENDS the turn. Measured against claude
 * 2.1.241, `result` and then `session_state_changed: idle` land about a
 * millisecond after the tool fires, so the gateway writes 'idle' while the work
 * the agent just announced is still running and the model is parked waiting to
 * be woken by it. On the claude-sdk backend that is not an edge case — every
 * Agent call is backgrounded by default — and it delivered exactly the preamble
 * this gate exists to stop, through the one door it did not cover.
 *
 * A session whose `state` is stuck at 'working' for ever — a bug in the working
 * signal, not in this rule — holds its push indefinitely. That is survivable and
 * on purpose: the message itself is not lost, it still marks the session unread
 * in the sidebar and in the notifications inbox. Adding a clock ceiling here
 * would mean a long enough task gets its preamble pushed anyway, which is the
 * exact complaint this exists to answer.
 */
export function turnStillRunning(i: TurnInput): boolean {
  if (!i.snapshotAt) return false;
  if (i.now - i.snapshotAt.getTime() >= STATE_TRUSTED_MS) return false;
  if (i.state === 'working') return true;
  // The turn is over and the work is not: a backgrounded Bash or subagent ends
  // its turn the instant it is launched, so `state` reads 'idle' while the thing
  // the agent just promised to do is still running and the model is waiting to
  // be woken by it. Delivering here puts "I'll kick off the build" on the lock
  // screen — the same mid-turn preamble this whole gate exists to stop, arriving
  // through the one door it did not cover. Bounded, unlike the rule above; see
  // BACKGROUND_HOLD_MAX_MS.
  if (i.state === 'idle' && backgroundOutstanding(i.activity)) {
    return (i.heldMs ?? 0) < BACKGROUND_HOLD_MAX_MS;
  }
  return false;
}
