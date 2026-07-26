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
import { getFullRows, putFullRows } from '@/lib/chat-cache/db';
import type { CachedFullRow } from '@/lib/chat-cache/types';

export const OLDER_PAGE = 200;

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
  windowOldestId: string | undefined,
  mayHaveMore: boolean
): OlderPages {
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [serverSaysMore, setServerSaysMore] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [servedFromCache, setServedFromCache] = useState(false);
  const inFlight = useRef(false);
  const utils = trpc.useUtils();

  // The row a new page attaches above: the oldest we already hold.
  const anchorId = rows.length > 0 ? rows[0].id : windowOldestId;

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
        setServerSaysMore(res.hasMore);
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
  }, [anchorId, sessionId, utils]);

  const reset = useCallback(() => {
    setRows([]);
    setServerSaysMore(null);
    setServedFromCache(false);
  }, []);

  return {
    rows,
    // The server's answer wins once we have one; until then trust the seed.
    hasMore: serverSaysMore ?? mayHaveMore,
    loading,
    servedFromCache,
    loadMore,
    reset,
  };
}
