// Applying a chat-stream push to the React Query cache.
//
// The SSE stream used to re-send the whole window on every change — 60 rows,
// measured at 105–120KB, for a push that usually carries one new row. It sends
// only what changed now (`rows`) plus what left the window (`gone`), so this
// function is the piece that has to reconstitute a full, correctly ordered
// window from a fragment.
//
// Two properties matter as much as correctness:
//
//  · REFERENCE STABILITY. Replacing the cache wholesale gives every row a fresh
//    object (rows come out of JSON.parse), so memoized MessageRows can't bail
//    and the whole transcript re-renders — markdown re-parse plus highlight.js,
//    several times a second while a turn streams. Any row whose role and content
//    are unchanged keeps its previous object, so only the genuinely-changed row
//    gets a new reference; and if nothing changed at all, the previous ARRAY
//    comes back too, letting memo(MessageTimeline) bail entirely.
//
//  · The per-row signature is cached on the (immutable) row object, so a reused
//    row is never re-stringified. Steady-state cost is one JSON.stringify per
//    CHANGED row, not per row.

const rowSigCache = new WeakMap<object, string>();

function rowSig(m: { content: unknown }): string {
  let s = rowSigCache.get(m);
  if (s === undefined) {
    s = JSON.stringify(m.content);
    rowSigCache.set(m, s);
  }
  return s;
}

export type CachedMsg = { id: string; role: string; content: unknown; createdAt: Date | string };

/** Same order the server sends: ascending by createdAt, id breaking ties. */
function order(a: CachedMsg, b: CachedMsg): number {
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merge a push into the cached window.
 *
 * `next` is whatever the push carried: a delta (the changed rows) or a whole
 * window — the same code serves both, because a whole window is just a delta
 * that happens to mention every row.
 *
 * `gone` is how a row LEAVES. The stream reports an id it has sent and can no
 * longer see, which covers both a row scrolled out by newer ones and a row
 * genuinely deleted; without it a delta-fed cache could only ever grow, and a
 * long session would quietly accumulate every row it had ever been told about.
 */
export function applyMessagePush<T extends CachedMsg>(
  prev: T[] | undefined,
  next: readonly T[],
  gone?: readonly string[],
): T[] {
  if (!prev || prev.length === 0) return gone?.length ? next.filter((n) => !gone.includes(n.id)) : [...next];

  const byId = new Map<string, T>(prev.map((m) => [m.id, m]));
  for (const n of next) {
    const old = byId.get(n.id);
    // An unchanged row keeps its identity even when the push re-sends it, which
    // is what a full-window push does to 59 rows out of 60.
    byId.set(n.id, old && old.role === n.role && rowSig(old) === rowSig(n) ? old : n);
  }
  if (gone) for (const id of gone) byId.delete(id);

  const out = [...byId.values()].sort(order);

  // Element-wise identical → hand the previous array back, reference and all.
  if (out.length === prev.length && out.every((m, i) => m === prev[i])) return prev;
  return out;
}

/** One frame off the stream: the rows it changed, and the ids that left the window. */
export type PushFrame<T> = { rows: readonly T[]; gone?: readonly string[] };

/**
 * Fold pushes that arrived BEFORE the window they belong to.
 *
 * The first stream connect asks the server to skip its initial full-window emit
 * — `listMessages` is already in flight for the same window, and sending it
 * twice costs ~150KB on open. That leaves a gap of one round trip in which the
 * stream can push a delta at a cache that has nothing in it yet, and a delta
 * applied to nothing IS the whole window as far as everything downstream can
 * tell: on a session that is mid-turn (a push every ~250ms) opening the chat
 * replaced the timeline restored from IndexedDB with the one row the push
 * carried. Measured on production, 1440x900: 13 rows / 1746px of transcript
 * became 1 row / 723px, one viewport, so the browser clamped scrollTop to 0 and
 * the reader — who was correctly at the bottom 90ms earlier — was ~1100px above
 * it until the query answered and the prepend anchor had walked the whole
 * height back. Idle sessions never showed it because no push lands in the gap.
 *
 * So the pushes in that gap are held instead of written, and folded onto the
 * window the moment it lands. Order is preserved: a later frame's version of a
 * row wins, and an id reported gone stays gone.
 */
export function foldPushes<T extends CachedMsg>(
  base: T[] | undefined,
  frames: readonly PushFrame<T>[],
): T[] {
  return frames.reduce<T[]>((acc, f) => applyMessagePush(acc, f.rows, f.gone), base ?? []);
}
