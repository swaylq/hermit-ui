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

import { useCallback, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { currentScope } from '@/lib/chat-cache/sync';
import { getFullRows, putFullRows, getSessionText, getSessions } from '@/lib/chat-cache/db';
import type { CachedFullRow } from '@/lib/chat-cache/types';
import { summaryPage, type CachedRow } from '@/lib/chat-cache/summary-page';

// Messages per "load earlier". Deliberately one screenful-ish rather than a big
// slab: 200 messages of markdown parse + syntax highlight blocks the main thread
// for seconds, and during that block nothing — not even the scroll anchor — can
// run, so the user watches the conversation sit visibly displaced. Smaller pages
// keep each step under a frame budget the anchor can ride, and make the
// scrollbar grow in gentle steps instead of one lurch.
export const OLDER_PAGE = 60;

// Summary mode pages out of the local cache, so a page can be counted in rows
// the reader will actually SEE rather than in raw messages that mostly get
// filtered away — and it costs no request, so it can afford to be generous.
// 40 prose rows is several screens.
export const SUMMARY_PAGE = 40;

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
  mayHaveMore: boolean,
  summary: boolean
): OlderPages {
  // History is accumulated PER MODE. The two are different projections of the
  // same past — summary rows carry prose and cards, full rows carry everything —
  // so showing one where the other is expected would be a quiet lie. Keeping
  // both means toggling costs you your place in the other mode's history, not
  // the history itself: toggle back and it is still there.
  const [fullRows, setFullRows] = useState<TimelineRow[]>([]);
  const [summaryRows, setSummaryRows] = useState<TimelineRow[]>([]);
  const rows = summary ? summaryRows : fullRows;
  const setRows = summary ? setSummaryRows : setFullRows;
  // "Is there more history?" is answered per mode, because the two pagers walk
  // the same past at different rates — but it must be answered by WHICHEVER path
  // served the page. Routing the server's answer into a field only full mode
  // read is what left summary mode pulling forever at the end of a session.
  const [fullSaysMore, setFullSaysMore] = useState<boolean | null>(null);
  const [summarySaysMore, setSummarySaysMore] = useState<boolean | null>(null);
  const setSaysMore = summary ? setSummarySaysMore : setFullSaysMore;
  const [loading, setLoading] = useState(false);
  const [servedFromCache, setServedFromCache] = useState(false);
  const inFlight = useRef(false);
  const utils = trpc.useUtils();

  // The row a new page attaches above: the oldest we already hold. Carried as
  // (createdAt, id) because the summary pager positions by ORDER — the row the
  // timeline starts at is usually a tool result, which has no prose and so is
  // absent from the prose cache entirely.
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

        // ── summary mode: straight off the disk ──────────────────────────────
        // The search cache holds every message's prose for the whole workspace,
        // and prose is exactly what summary mode renders — so this page costs no
        // request at all. Only for sessions the sync has actually completed
        // (a `sessions` row exists); anything else falls through to the server.
        // Old history is append-only, so "synced once" means "has all of it".
        if (summary && scope && anchorId && anchorAt) {
          const synced = (await getSessions(scope)).some((x) => x.sessionId === sessionId);
          if (synced) {
            const cached = (await getSessionText(scope, sessionId)) as CachedRow[];
            const page = summaryPage(cached, { createdAt: anchorAt, id: anchorId }, SUMMARY_PAGE);
            if (page.rows.length > 0) {
              setRows((prev) => [...page.rows, ...prev]);
              setSaysMore(page.hasMore);
              setServedFromCache(true);
              return;
            }
            // Nothing older in the cache: that IS the beginning of the session.
            setSaysMore(false);
            return;
          }
        }

        // ── cache first ──────────────────────────────────────────────────────
        // Only use the cache when it covers a WHOLE page. A partial hit would
        // have to be stitched to a server page, and getting that seam wrong
        // means duplicated or skipped messages; taking the whole page from one
        // source keeps it trivially correct.
        if (scope) {
          const cached = await getFullRows(scope, sessionId);
          const at = cached.findIndex((r) => r.id === anchorId);
          if (at >= OLDER_PAGE) {
            const page = cached.slice(at - OLDER_PAGE, at);
            setRows((prev) => [...page, ...prev]);
            setServedFromCache(true);
            return;
          }
        }

        // ── server ───────────────────────────────────────────────────────────
        const res = await utils.client.chat.listMessagesBefore.query({
          sessionId,
          beforeId: anchorId,
          limit: OLDER_PAGE,
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
          if (scope) {
            const payload: CachedFullRow[] = res.rows.map((r) => ({
              id: r.id,
              sessionId,
              role: r.role,
              content: r.content,
              createdAt: typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString(),
            }));
            void putFullRows(scope, sessionId, payload).catch(() => {});
          }
        }
      } catch {
        // Leave hasMore alone so the button stays and the user can retry.
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    })();
  }, [anchorId, anchorAt, sessionId, utils, summary, setRows]);

  const reset = useCallback(() => {
    setFullRows([]);
    setSummaryRows([]);
    setFullSaysMore(null);
    setSummarySaysMore(null);
    setServedFromCache(false);
  }, []);

  return {
    rows,
    // Whichever pager is driving answers for itself; until it has, trust the seed.
    hasMore: (summary ? summarySaysMore : fullSaysMore) ?? mayHaveMore,
    loading,
    servedFromCache,
    loadMore,
    reset,
  };
}
