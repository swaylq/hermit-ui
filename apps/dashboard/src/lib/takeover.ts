// Brain takeover — lifecycle text and the one remaining guard.
// See docs/brain-takeover-design.md.
//
// A takeover runs until it's DONE. It used to also stop at 12 messages or 30 minutes,
// which was the wrong shape: those caps fired in the middle of real work and handed a
// half-finished job back, which is exactly the interruption the feature exists to
// avoid. The stopping conditions that survive are the ones that mean something:
//
//   · the Brain judges the goal met and releases;
//   · the Brain hits the safety floor and needs a decision only the human can make;
//   · the human types, or clicks Release — instant, and the reason the rest can be
//     unbounded: you are never more than one keystroke from having it back;
//   · the session closes.
//
// What keeps this from running away isn't a counter, it's the shape of the loop: the
// Brain only wakes when the AGENT produces something (the watcher pokes on a real
// transition, never on a timer), so it can't spin on its own. A Brain talking to an
// agent in circles is a judgement failure, and the `takeover` skill names it as one.
//
// Plain module with no server-only imports — same reason lib/chat-queue.ts exists:
// the router and the chat page must not be able to disagree about these numbers.

/**
 * Live takeovers allowed per machine. NOT a limit on how long or how hard the Brain
 * works — it's a resource guard. Each takeover holds its own Brain session, i.e. a
 * live claude process, and this machine has an OOM history. Raise it freely; it only
 * exists so a burst of handovers can't take the host down.
 */
export const TAKEOVER_CONCURRENCY = 8;

export type TakeoverEndReason =
  | 'done' // the Brain judged the goal met and released
  | 'human' // the human typed into the session, or clicked Release
  | 'closed'; // the session was closed / deleted underneath it

/**
 * The system row written into the conversation when a takeover ends. It goes in
 * the transcript itself — not a toast — because "who was driving when this was
 * decided" is exactly the thing you want to still be able to see next week.
 */
export function endNote(reason: TakeoverEndReason, summary?: string | null): string {
  const head =
    reason === 'done'
      ? 'Brain finished and handed the conversation back.'
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
