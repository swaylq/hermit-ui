// How well THIS BROWSER can currently reach the dashboard. One fact, kept in one
// place, read by every view that has to judge whether a row it is holding is
// still evidence about anything.
//
// Why it exists — the stale flicker, 2026-08-21. `sessionStatusView` calls a
// session `stale` when its `snapshotAt` is older than SNAPSHOT_STALE_MS, and it
// measured that age against the browser's wall clock. That silently conflates
// two opposite failures:
//
//   - the GATEWAY went quiet. This is the one `stale` exists for: nothing else
//     in the pipeline ever clears a `state` of 'working', so without an expiry a
//     gateway that dies mid-turn leaves the dot pulsing amber forever.
//   - WE went quiet. The number in hand is old because we stopped asking, not
//     because nobody answered — a poll queued behind a stalled dashboard, a
//     backgrounded tab, a dropped connection.
//
// Only the first deserves a grey dot, and the second is the common one. The
// reported symptom: an agent partway through a long task flips to "stale" for a
// few seconds whenever a tool finishes. Neither half of that is a coincidence.
// A finishing tool is a large /api/sync/chat-message POST, which stalls the
// dashboard's single Node event loop (see server/auth.ts — the same starvation
// once queued gateway polls for ~30s in bursts), so the browser's own 5s
// listSessions/getSession polls queue behind it while Date.now() keeps marching.
// And it is only VISIBLE at a tool boundary because that is exactly when the
// chat page's fast local `working` signal lapses — a long tool call emits
// nothing, so `isInFlight` decays and the dot falls back to the snapshot it has
// been quietly failing to refresh.
//
// The whole record is derived from ONE signal: when a query carrying session
// rows last came back with an answer. Deliberately not two — the obvious second
// signal, "a fetch failed", can be produced forever by a single misbehaving
// query (a stale session id, a rejected key) while everything else is healthy,
// and a permanently-recent failure stamp would switch `stale` off for the whole
// fleet with nothing on screen to say so. A GAP in answers cannot be faked that
// way: it exists only if the answers actually stopped.
//
// Deliberately module-level rather than context or a prop: contact with the
// dashboard is a property of the tab, not of any row, and the sidebar renders
// tens of memo'd session rows whose whole point is not to re-render on a no-op
// poll. A value that changed every 5s would defeat that memo for every row; a
// synchronous read inside a render that already calls Date.now() does not.

export interface DashboardReach {
  /**
   * When a query carrying session rows last RESOLVED. 0 = we have never had an
   * answer, which is "no basis to judge" — not "everything is stale". That case
   * is real on first paint: the sidebar paints from its IndexedDB cache, whose
   * rows can be hours old, before the first poll lands.
   */
  observedAt: number;
  /**
   * When the current unbroken run of contact began. Anything the gateway failed
   * to write before this moment is explained by the same outage that blinded us,
   * so the staleness clock starts here rather than at the snapshot.
   */
  reachableSince: number;
}

/**
 * A gap between answers wider than this means we lost the thread rather than
 * merely waited a beat.
 *
 * Both carriers poll at 5s, so a healthy run is 5s ± jitter and never trips
 * this. Above the gateway's own 8s snapshot tick, because that is the point: a
 * gap this wide could have swallowed a snapshot we never saw, so on the far side
 * of it we cannot tell a gateway that stopped writing from one whose writes we
 * missed. Well under SNAPSHOT_STALE_MS, so the grace this buys is bounded by the
 * same threshold as everything else — a gateway that is genuinely gone is still
 * called out 45s after contact is restored.
 */
export const CONTACT_GAP_MS = 15_000;

let observedAt = 0;
let reachableSince = 0;

/**
 * The procedures that carry the session rows `sessionStatusView` reads. Scoped
 * on purpose: "did we hear back" has to mean "about THIS data". A query on a
 * slower beat, or one that happens to be disabled, must not vouch for rows
 * nobody refreshed.
 */
const CARRIERS = new Set(['listSessions', 'getSession']);

/**
 * Does this query key belong to a procedure that carries session rows?
 *
 * tRPC keys are `[['chat','listSessions'], {input, type}]`. Matching the head
 * segment loosely (either the nested path array or a flat key) keeps this from
 * silently matching nothing if that shape ever changes — and if it does stop
 * matching, `observedAt` simply stays 0, which reads as "no evidence" and leaves
 * every dot on its last known state rather than greying the fleet.
 */
export function carriesSessionRows(key: unknown): boolean {
  if (!Array.isArray(key)) return false;
  const head = Array.isArray(key[0]) ? key[0] : key;
  return head.some((seg) => typeof seg === 'string' && CARRIERS.has(seg));
}

/**
 * Record that the dashboard answered us.
 *
 * Monotonic: React Query can settle a slow request after a fast one, so events
 * do arrive out of order, and a stamp that walked backwards would re-age rows
 * that are current.
 */
export function noteDashboardAnswer(at: number = Date.now()): void {
  if (at <= observedAt) return;
  // A wide gap since the last answer — including the very first one, where the
  // "previous answer" is the beginning of time — starts a new run of contact.
  if (at - observedAt > CONTACT_GAP_MS) reachableSince = at;
  observedAt = at;
}

/** Spread straight into `sessionStatusView`'s opts — the keys are its opt names. */
export function dashboardReach(): DashboardReach {
  return { observedAt, reachableSince };
}

/** Tests only. */
export function resetDashboardReach(): void {
  observedAt = 0;
  reachableSince = 0;
}

/** The shape of a QueryCache, narrowed to what this file uses. */
interface CacheLike {
  subscribe(listener: (event: unknown) => void): () => void;
}

/**
 * Feed the record from the app's QueryCache. Installed once, next to the
 * QueryClient itself (app/providers.tsx), because that is the only place that
 * sees every fetch regardless of which view issued it.
 *
 * `manual` is the trap here, and it is not a small one. `setQueryData` — which
 * this app calls on every mark-read, every optimistic rename, every unarchive —
 * dispatches the SAME 'success' action a completed fetch does, flagged
 * `manual: true`. Counting those would have the browser vouching for rows it
 * wrote itself, most often while a turn is running and marking messages read,
 * which is precisely when the polls it is standing in for are stalled. The
 * record would then be freshest exactly when it is least true.
 */
export function watchDashboardReach(cache: CacheLike): () => void {
  return cache.subscribe((event) => {
    const e = event as {
      type?: string;
      query?: { queryKey?: unknown };
      action?: { type?: string; manual?: boolean };
    };
    if (e?.type !== 'updated' || e.action?.type !== 'success' || e.action.manual) return;
    if (!carriesSessionRows(e.query?.queryKey)) return;
    noteDashboardAnswer();
  });
}
