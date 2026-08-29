// The live window's identity, in one place.
//
// The chat page and the sidebar's hover-prefetch have to ask chat.listMessages
// the SAME question, or the prefetch warms a cache entry the page never reads
// and every session click pays the network again. That agreement used to be two
// `60` literals in two files, each carrying a comment telling the next person
// about the other one (chat/page.tsx and sidebar/recent-lists.tsx). Adding
// `digest` would have made it two fields to keep in step instead of one, so the
// input moved here and the literals went away.
//
// Anything that reads or writes this query's cache entry by key —
// `utils.chat.listMessages.getData` / `setData` in the SSE merge path — must
// build the key from `timelineQueryInput` too. A partial-key
// `invalidate({ sessionId })` still matches and needs nothing.

/**
 * The LIVE window: the newest N messages, and the only thing listMessages (and
 * the SSE stream keyed on it) ever carries. Kept small so a session opens fast —
 * less JSON over the wire + far fewer markdown/highlight passes on first paint —
 * since the visible viewport is only ~15-20 messages.
 *
 * It is FIXED. "Load earlier" used to grow it, which made each click re-fetch
 * everything already on screen and dragged the SSE stream up with it; older
 * history is now paged separately by useOlderPages.
 */
export const INITIAL_WINDOW = 60;

/**
 * Ask for the window as the collapsed timeline renders it — tool arguments
 * trimmed to the preview the chip shows, results to their first line, thinking
 * to its length (server/message-digest.ts). Opening a capsule fetches the real
 * bodies through `chat.getMessages`, which the timeline already does for
 * history through the same resolver.
 *
 * Measured 2026-08-29 over all 648 sessions' newest-60 windows, gzipped:
 * 14 → 6 KB at the median, 30 → 9 KB at p90, 67 → 21 KB at p99.
 *
 * Set false to put the live window back on full fidelity; the server accepts
 * both and the two shapes render identically, so this is a safe kill switch.
 */
export const TIMELINE_DIGEST = true;

/** The exact input every reader of the live window must pass. */
export function timelineQueryInput(sessionId: string) {
  return { sessionId, limit: INITIAL_WINDOW, digest: TIMELINE_DIGEST };
}

/**
 * The matching SSE query string. The stream merges by id into the very list
 * `timelineQueryInput` fetched, so its `digest` has to agree — a full-fidelity
 * row landing in a digested window would re-expand a capsule the reader had
 * collapsed, and change its height under them.
 */
export function timelineStreamParams(sessionId: string, opts: { skipInitial: boolean }): string {
  const p = new URLSearchParams({
    sessionId,
    limit: String(INITIAL_WINDOW),
    delta: '1',
    // We understand `event: status` frames — the session's runtime state pushed
    // as the gateway writes it. Opt-in because a bundle that predates this reads
    // every frame on the stream as a message push; see the route's `wantsStatus`.
    status: '1',
  });
  if (TIMELINE_DIGEST) p.set('digest', '1');
  if (opts.skipInitial) p.set('skipInitial', '1');
  return p.toString();
}
