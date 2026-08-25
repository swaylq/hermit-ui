/**
 * The part of `.loop-state.json` that belongs to one chat session.
 *
 * A loop rides the single Claude session that created it, but the file it lives
 * in is agent-directory-level, so the gateway attaches the WHOLE thing to every
 * session of that agent. `getSession` polls every 5 seconds, which meant each
 * open tab pulled every sibling session's loops — including their `prompt` and
 * their last result, which is a paragraph of prose — twelve times a minute, and
 * then threw all of it away in the browser.
 *
 * Measured on a real agent directory with four loops: 1,740 bytes on the wire of
 * which 565 belong to the session asking. 1,175 wasted bytes per poll, 68% of
 * the payload, ~14KB per minute per open tab.
 *
 * The predicate is deliberately the same one `LoopBar` already applies, down to
 * the falsy check: a loop written before ownership stamping has no
 * `ownerSessionId` and is still shown everywhere, and anything that is not an
 * object is passed through rather than dropped, because that is what the client
 * did with it. Filtering here has to be invisible, not merely reasonable.
 *
 * `schedules` is untouched — cron entries are agent-level on purpose.
 */
export function loopStateForSession(raw: unknown, sessionId: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const state = raw as { loops?: unknown };
  if (!Array.isArray(state.loops)) return raw;
  const loops = state.loops.filter((loop) => {
    const owner = (loop as { ownerSessionId?: unknown } | null)?.ownerSessionId;
    return !owner || owner === sessionId;
  });
  // Nothing to trim: hand back the identical object so an unchanged payload
  // stays byte-for-byte what it was.
  if (loops.length === state.loops.length) return raw;
  return { ...state, loops };
}
