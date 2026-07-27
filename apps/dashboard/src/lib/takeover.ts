// Brain takeover — limits and lifecycle text. See docs/brain-takeover-design.md.
//
// The Brain drives a conversation the human was already having, sending messages
// to the agent on their behalf until it judges the goal met. Two things have to be
// true for that to be safe to hand a machine:
//
//   1. It has to STOP on its own schedule OR ours, whichever comes first. The caps
//      below are ours, and they're enforced in `chat.send` — a Brain that decides
//      to keep going simply gets its 13th message rejected. Asking the Brain nicely
//      in a skill is guidance; this is the guarantee.
//   2. The human has to be able to take the wheel back instantly. Typing into the
//      session does it (chat.send ends the takeover when a human-authored message
//      arrives), so the reflex — just answer — is also the escape hatch.
//
// Plain module with no server-only imports — same reason lib/chat-queue.ts exists:
// the tRPC router ENFORCES these limits and the chat page DISPLAYS them, and the two
// must never be able to disagree about the numbers. Also keeps the arithmetic
// unit-testable without a database.

/** Brain messages allowed per takeover before it's handed back automatically. */
export const TAKEOVER_TURN_CAP = 12;

/** Wall-clock ceiling on a single takeover. Whichever cap trips first wins. */
export const TAKEOVER_MAX_AGE_MS = 30 * 60_000;

/**
 * Live takeovers allowed per machine. Each one is the Brain driving a real claude
 * process, so this is the difference between "an assistant is working on something"
 * and "the whole fleet is talking to itself".
 */
export const TAKEOVER_CONCURRENCY = 3;

export type TakeoverEndReason =
  | 'done' // the Brain judged the goal met and released
  | 'turns' // hit TAKEOVER_TURN_CAP
  | 'age' // hit TAKEOVER_MAX_AGE_MS
  | 'human' // the human typed into the session, or clicked Release
  | 'closed'; // the session was closed / deleted underneath it

export interface TakeoverState {
  takeoverTurns: number;
  takeoverStartedAt: Date | null;
}

export type LimitCheck = { over: false } | { over: true; reason: 'turns' | 'age' };

/**
 * Has this takeover run out of road? Evaluated before each Brain message, so the
 * cap is a refusal at the boundary rather than a cleanup after the fact.
 *
 * A null `takeoverStartedAt` means the row isn't in a takeover at all; callers
 * check that separately, and age is simply not enforced here.
 */
export function checkLimits(s: TakeoverState, now: number): LimitCheck {
  if (s.takeoverTurns >= TAKEOVER_TURN_CAP) return { over: true, reason: 'turns' };
  if (s.takeoverStartedAt && now - s.takeoverStartedAt.getTime() >= TAKEOVER_MAX_AGE_MS) {
    return { over: true, reason: 'age' };
  }
  return { over: false };
}

/**
 * The system row written into the conversation when a takeover ends. It goes in
 * the transcript itself — not a toast — because "who was driving when this was
 * decided" is exactly the thing you want to still be able to see next week.
 */
export function endNote(reason: TakeoverEndReason, summary?: string | null): string {
  const head =
    reason === 'done'
      ? 'Brain finished and handed the conversation back.'
      : reason === 'turns'
        ? `Brain reached its ${TAKEOVER_TURN_CAP}-message limit and handed the conversation back.`
        : reason === 'age'
          ? `Brain reached its ${Math.round(TAKEOVER_MAX_AGE_MS / 60_000)}-minute limit and handed the conversation back.`
          : reason === 'human'
            ? 'You took the conversation back.'
            : 'Takeover ended — the session closed.';
  const tail = summary?.trim() ? ` ${summary.trim()}` : '';
  return `[takeover] ${head}${tail}`.slice(0, 500);
}

/** The system row written when a takeover starts. */
export function startNote(): string {
  return '[takeover] Brain is now driving this conversation. Type anything to take it back.';
}
