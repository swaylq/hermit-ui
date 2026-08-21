'use client';

// "Load earlier", paginated properly and served from the local cache when it can be.
//
// The old model grew listMessages' window (60 → 260 → 460 …), so every click
// re-downloaded everything already on screen — measured at +404 KB, +634 KB and
// +898 KB for three clicks, 1.9 MB to read back 600 messages. It also dragged
// the SSE stream along, since that is keyed on the same window: after a few
// clicks each 250 ms tick re-sent hundreds of rows.
//
// Now the live window stays pinned at its initial size and older history is
// accumulated here as fixed-size pages. Two consequences worth stating:
//   · each click costs the same as the first, and
//   · a page already in the local cache is prepended with NO network call at
//     all — scrolling back through a session you've read before is instant.
//
// Old history is safe to serve from cache: messages are append-only, and the
// in-place upserts the gateway performs only ever touch the live tail (the row
// it is currently streaming), never rows this far back.

import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { currentScope } from '@/lib/chat-cache/sync';
import { getFullRows, getDigestRows, putDigestRows } from '@/lib/chat-cache/db';
import type { CachedFullRow } from '@/lib/chat-cache/types';

// Messages per "load earlier". Deliberately not a big slab: 200 messages of
// markdown parse + syntax highlight blocks the main thread for seconds, and
// during that block nothing — not even the scroll anchor — can run, so the user
// watches the conversation sit visibly displaced.
//
// 60 → 120 once pages started arriving DIGESTED and tool chains started folding
// into one capsule each. Both sides of the old budget moved: a page costs a
// fraction of the bytes (server/message-digest.ts), and a page of 120 raw
// messages lays out FEWER rows than 60 used to, because ~3/4 of them are
// machinery that now collapses. Two round trips became one.
export const OLDER_PAGE = 120;

/**
 * How long after a session opens the next page is fetched in the background.
 *
 * Not immediate: the sidebar's own prefetch was once eager for eight sessions
 * and inflated server TTFB to ~1s by competing with the load of the session the
 * user was actually opening. This is one page, for the session already open,
 * and it waits until that first paint is done.
 */
const WARM_DELAY_MS = 1_500;

/**
 * The last `size` rows strictly before `edge`, or null when the store does not
 * hold a whole page — see the call site for why a partial hit is refused.
 * `(createdAt, id)` is the same total order the server pages by.
 *
 * Exported for its tests: a seam that duplicates or skips a message is invisible
 * until someone reads back through history and finds a turn twice.
 */
export function pageBefore<T extends { id: string; createdAt: string | Date }>(
  rows: T[],
  edge: { createdAt: string; id: string },
  size: number
): T[] | null {
  const older = rows.filter((r) => {
    const at = typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString();
    return at !== edge.createdAt ? at < edge.createdAt : r.id < edge.id;
  });
  return older.length >= size ? older.slice(older.length - size) : null;
}

export type TimelineRow = { id: string; role: string; content: unknown; createdAt: Date | string };

export type OlderPages = {
  rows: TimelineRow[];
  hasMore: boolean;
  loading: boolean;
  /** True when the most recent page came from IndexedDB (no request). */
  servedFromCache: boolean;
  loadMore: () => void;
  reset: () => void;
};

/**
 * @param sessionId       the open session
 * @param windowOldestId  id of the oldest row in the LIVE window — the point
 *                        older pages attach to
 * @param mayHaveMore     seed for `hasMore`: the live window came back full, so
 *                        there is probably history behind it
 */
export function useOlderPages(
  sessionId: string,
  windowOldest: { id: string; createdAt: Date | string } | undefined,
  mayHaveMore: boolean
): OlderPages {
  const [rows, setRows] = useState<TimelineRow[]>([]);
  // Null until a page has actually been served; the seed answers until then.
  // It must be set by WHICHEVER path served that page — routing the server's
  // answer into a field the caller did not read is what once left the pager
  // pulling forever at the beginning of a session.
  const [saysMore, setSaysMore] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [servedFromCache, setServedFromCache] = useState(false);
  const inFlight = useRef(false);
  const utils = trpc.useUtils();

  // The row a new page attaches above: the oldest we already hold. Carried as
  // (createdAt, id) rather than as an id, because a page is positioned by ORDER
  // — see pageBefore, and the cache-first branch's note on why the anchor is
  // often absent from the store being read.
  const edge = rows.length > 0 ? rows[0] : windowOldest;
  const anchorId = edge?.id;
  const anchorAt = edge
    ? typeof edge.createdAt === 'string'
      ? edge.createdAt
      : edge.createdAt.toISOString()
    : undefined;

  const loadMore = useCallback(() => {
    if (inFlight.current || !anchorId) return;
    inFlight.current = true;
    setLoading(true);
    void (async () => {
      try {
        const scope = currentScope();

        // ── cache first ──────────────────────────────────────────────────────
        // Only use the cache when it covers a WHOLE page. A partial hit would
        // have to be stitched to a server page, and getting that seam wrong
        // means duplicated or skipped messages; taking the whole page from one
        // source keeps it trivially correct. `hasMore` is deliberately NOT set
        // from here: holding a full page proves there is history, not that the
        // store holds all of it.
        //
        // `full` before `digest` — same page, better fidelity, same zero cost.
        // Positioned by (createdAt, id) rather than by an id lookup, because the
        // row the timeline currently starts at need not be in the store being
        // read: on the first pull the anchor is the oldest LIVE-window row, which
        // the write-through put in `full` and nothing ever put in `digest`.
        if (scope && anchorAt) {
          const edge = { createdAt: anchorAt, id: anchorId };
          for (const read of [getFullRows, getDigestRows]) {
            const page = pageBefore(await read(scope, sessionId), edge, OLDER_PAGE);
            if (!page) continue;
            setRows((prev) => [...page, ...prev]);
            setServedFromCache(true);
            return;
          }
        }

        // ── server ───────────────────────────────────────────────────────────
        // Digested: the collapsed timeline shows tool NAMES and first lines, and
        // three quarters of an undigested page is tool output nobody paints.
        // Opening a capsule fetches its real bodies (chat.getMessages).
        const res = await utils.client.chat.listMessagesBefore.query({
          sessionId,
          beforeId: anchorId,
          limit: OLDER_PAGE,
          digest: true,
        });
        setServedFromCache(false);
        // A page that came back empty is the beginning of the session, whatever
        // else anyone claims. Trusting only the reported flag is how a button
        // ends up pulling forever: it stays offered, every scroll at the top
        // fires another pull, each returns nothing, and the label flickers
        // between "loading…" and "↑ load earlier" without the list moving.
        setSaysMore(res.hasMore && res.rows.length > 0);
        if (res.rows.length > 0) {
          setRows((prev) => [...res.rows, ...prev]);
          // Persist so the NEXT walk back through this history needs no network.
          // Into `digest`, not `full`: these rows have had their tool bodies
          // trimmed, and writing them into the store the LIVE window is served
          // from would let a first paint come back missing what it used to show.
          //
          // `authoredBy` rides along. Dropping it (as this once did) is invisible
          // until the page is served from cache, at which point a Brain-spoken or
          // machine-poked row renders as though the human had typed it.
          if (scope) {
            const payload: CachedFullRow[] = res.rows.map((r) => ({
              id: r.id,
              sessionId,
              role: r.role,
              content: r.content,
              createdAt: typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString(),
              authoredBy: r.authoredBy ?? null,
            }));
            void putDigestRows(scope, sessionId, payload).catch(() => {});
          }
        }
      } catch {
        // Leave hasMore alone so the button stays and the user can retry.
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    })();
  }, [anchorId, anchorAt, sessionId, utils]);

  // ── Warm the next page ──────────────────────────────────────────────────
  //
  // Opening a session paints the live window and nothing else, and the live
  // window is 60 raw messages — which since tool chains started folding is far
  // less conversation than it used to be. Measured across eight real sessions
  // on this machine: 82% of messages are machinery, and the newest 60 lay out
  // 18.8 rows on average, as few as 4 in a tool-heavy stretch. So the first
  // scroll up almost always lands on a fetch, and the reader waits.
  //
  // A page is already prepended with zero network when the local store holds it
  // (see loadMore's cache-first branch). This just makes that the common case
  // for a session's FIRST scroll back too: fetch one digested page into
  // IndexedDB, on idle, once per session — and touch nothing on screen. What
  // the user sees is unchanged; what changes is that scrolling up finds it
  // already there.
  const warmed = useRef<string | null>(null);
  useEffect(() => {
    if (!anchorId || !anchorAt) return;
    if (rows.length > 0) return;             // already reading back; loadMore owns it
    if (!(saysMore ?? mayHaveMore)) return;  // nothing behind this session
    if (warmed.current === sessionId) return;
    warmed.current = sessionId;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const scope = currentScope();
          if (cancelled || inFlight.current) return;
          const edge = { createdAt: anchorAt, id: anchorId };
          // Already held? Then the scroll back is already free — don't spend a
          // request proving it.
          if (scope) {
            for (const read of [getFullRows, getDigestRows]) {
              if (pageBefore(await read(scope, sessionId), edge, OLDER_PAGE)) return;
            }
          }
          if (cancelled || inFlight.current) return;
          const res = await utils.client.chat.listMessagesBefore.query({
            sessionId, beforeId: anchorId, limit: OLDER_PAGE, digest: true,
          });
          if (cancelled || res.rows.length === 0 || !scope) return;
          // Into the store only. Prepending here would move the timeline under a
          // reader who did nothing, which is the one thing this whole subsystem
          // exists to prevent.
          await putDigestRows(scope, sessionId, res.rows.map((r) => ({
            id: r.id,
            sessionId,
            role: r.role,
            content: r.content,
            createdAt: typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString(),
            authoredBy: r.authoredBy ?? null,
          })) as CachedFullRow[]);
        } catch { /* a warm page is an optimisation; failing to get one is not an error */ }
      })();
    }, WARM_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId, anchorId, anchorAt, rows.length, saysMore, mayHaveMore, utils]);

  const reset = useCallback(() => {
    setRows([]);
    setSaysMore(null);
    setServedFromCache(false);
    warmed.current = null;
  }, []);

  return {
    rows,
    // Until a page has been served and answered for itself, trust the seed.
    hasMore: saysMore ?? mayHaveMore,
    loading,
    servedFromCache,
    loadMore,
    reset,
  };
}
