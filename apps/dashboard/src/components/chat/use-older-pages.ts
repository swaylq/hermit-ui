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
import { getFullRows, getDigestRows, putDigestRows, evictFullLru } from '@/lib/chat-cache/db';
import type { CachedFullRow } from '@/lib/chat-cache/types';

// Messages per "load earlier". Deliberately small: 120 digested messages of
// markdown parse + syntax highlight blocked the main thread long enough on a
// phone that the prepend anchor's settle window expired before it ever ran, and
// the view painted displaced. 60 keeps the whole page's parse near a frame, and
// the commit below splits it into two 30-row chunks so each chunk stays WELL
// under a frame.
export const OLDER_PAGE = 60;

// How many rows of a fetched page land in the DOM per commit. Each chunk is its
// own React render, and between chunks the prepend anchor re-asserts (see the
// layout effect in chat/page.tsx), so the worst displacement the reader can see
// is one chunk's height — not the whole page's.
export const COMMIT_CHUNK = 30;

/**
 * How long after a session opens the warm-up fetch begins.
 *
 * Not immediate: the sidebar's own prefetch was once eager for eight sessions
 * and inflated server TTFB to ~1s by competing with the load of the session the
 * user was actually opening. This waits until that first paint is done.
 */
const WARM_DELAY_MS = 1_500;

// The whole-session digest warm (below) walks back through history in batches
// this big. The interactive page is 60; a warm batch is larger because it is
// written straight to IndexedDB and never parsed for the screen, so a bigger
// page only means fewer round trips.
const WARM_BATCH = 200;

// How many warm batches one open is allowed to fetch. 20 × 200 = 4,000 messages
// of history, which is several hundred screens of scroll-back; past that the
// leading-page prefetch (one page ahead of the reader) keeps extending the
// cache as they actually scroll. Keeps the digest store from trying to hold a
// 26k-message session in full on a phone.
const WARM_MAX_PAGES = 20;

// Gap between warm batches, so the background walk never competes with the live
// turn or the SSE stream on the same server.
const WARM_GAP_MS = 120;

/**
 * The `size` rows immediately before `edge`, or null when the store cannot PROVE
 * it holds them as an unbroken run.
 *
 * The proof is the `nextId` each row was stamped with when it was written (see
 * CachedFullRow.nextId): start at the edge, take the row that claims to come
 * directly before it, and repeat. A missing link stops the walk and the whole
 * page is refused, so the caller fetches it from the server instead.
 *
 * This used to be "sort what the store holds, take the last `size` older than
 * the edge", which is only right if the store is contiguous — and it is not. It
 * accumulates live windows written minutes apart, and a session busy enough to
 * slide the window further than its own width between two writes leaves a gap.
 * Reading straight across one of those served a page with a hole in the middle,
 * and because paging only ever walks FURTHER back, nothing after that could
 * repair it: the hole outlived every reload. On the session this was written
 * for it swallowed 162 messages, fifteen minutes, and the auto-compaction
 * notice the user was looking for.
 *
 * The edge itself need not be in the store — only a row claiming to precede it.
 * That is the seam between the live window (`full`) and the pages below it
 * (`digest`), which no single store holds both sides of.
 *
 * Exported for its tests: a seam that duplicates or skips a message is invisible
 * until someone reads back through history and finds a turn twice.
 */
export function pageBefore<T extends { id: string; nextId?: string | null }>(
  rows: T[],
  edge: { id: string },
  size: number
): T[] | null {
  const before = new Map<string, T>();
  for (const r of rows) if (r.nextId) before.set(r.nextId, r);
  const page: T[] = [];
  let key = edge.id;
  for (let i = 0; i < size; i++) {
    const p = before.get(key);
    // No link, or the linked row is not held: a partial hit would have to be
    // stitched to a server page, and getting that seam wrong means duplicated or
    // skipped messages. Refuse the whole page instead.
    if (!p) return null;
    page.push(p);
    key = p.id;
  }
  return page.reverse();
}

/** `(createdAt, id)`, the total order the server pages by, as a boolean. */
function isOlder(
  a: { id: string; createdAt: string | Date },
  b: { id: string; createdAt: string | Date }
): boolean {
  const at = typeof a.createdAt === 'string' ? a.createdAt : a.createdAt.toISOString();
  const bt = typeof b.createdAt === 'string' ? b.createdAt : b.createdAt.toISOString();
  return at !== bt ? at < bt : a.id < b.id;
}

function byOrder(
  a: { id: string; createdAt: string | Date },
  b: { id: string; createdAt: string | Date }
): number {
  return isOlder(a, b) ? -1 : isOlder(b, a) ? 1 : 0;
}

/**
 * What the live window dropped off its old end between two renders.
 *
 * The window is a fixed 60 rows that slides forward as a turn produces
 * messages, and the rows it sheds are deleted from the query cache — by the
 * stream's `gone` list, or simply by the fallback poll returning a newer window.
 * That is right while the reader is at the tail: those rows are history, and
 * history is refetched from the server when they scroll back to it.
 *
 * It is wrong the moment they HAVE scrolled back. `older.rows` is anchored where
 * the window used to start, the window has since moved on, and everything shed
 * in between belongs to neither array — the timeline concatenates them and the
 * gap closes over silently. Measured on a live session: a 162-message,
 * fifteen-minute hole with the compaction notice inside it, unreachable because
 * paging only ever walks BACKWARDS from the oldest row on screen.
 *
 * So the shed rows are handed to the pager instead of dropped. Exported for its
 * test: nothing about a missing middle looks wrong on screen.
 */
export function shedRows<T extends { id: string; createdAt: string | Date }>(
  prev: readonly T[],
  // Deliberately not `readonly T[]`: the live window arrives either as server
  // rows (Date) or as rows read back from IndexedDB (string), and a single type
  // parameter would have to pick one of them.
  next: readonly { id: string; createdAt: string | Date }[]
): T[] {
  if (prev.length === 0 || next.length === 0) return [];
  const edge = next[0];
  const held = new Set(next.map((r) => r.id));
  // Older than the new window's first row, so a row DELETED from inside the
  // window (an undelivered queue row being dequeued — the other thing `gone`
  // reports) is still dropped rather than resurrected here.
  return prev.filter((r) => !held.has(r.id) && isOlder(r, edge));
}

/**
 * Append shed rows to the history already on screen.
 *
 * A no-op while `rows` is empty: the reader is at the tail, has asked for no
 * history, and holding onto everything the window sheds would grow the page for
 * a conversation nobody is reading back through.
 */
export function absorbShed<T extends { id: string; createdAt: string | Date }>(
  rows: T[],
  shed: readonly T[]
): T[] {
  if (rows.length === 0 || shed.length === 0) return rows;
  const have = new Set(rows.map((r) => r.id));
  const add = shed.filter((r) => !have.has(r.id)).sort(byOrder);
  if (add.length === 0) return rows;
  const out = [...rows, ...add];
  // Shed rows come off the window that sat directly after `rows`, so they are
  // newer than everything held and the concatenation is already ordered. Sort
  // the whole thing only when that is not true — a turn rendered out of
  // sequence is worse than one extra pass.
  if (isOlder(add[0], rows[rows.length - 1])) out.sort(byOrder);
  return out;
}

/**
 * Split a page (oldest→newest) into commit chunks, NEWEST chunk first.
 *
 * The newest chunk sits right above what the reader already has — it is the
 * history they reach next, so it goes in first and the anchor absorbs its growth
 * before the older chunk arrives above it. Exported for its test: the seam
 * between chunks must not duplicate or skip a row, exactly like pageBefore's.
 */
export function chunksBottomFirst<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = rows.length; i > 0; i -= size) {
    out.push(rows.slice(Math.max(0, i - size), i));
  }
  return out;
}

function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'undefined') {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type TimelineRow = {
  id: string;
  role: string;
  content: unknown;
  createdAt: Date | string;
  authoredBy?: string | null;
};

export type OlderPages = {
  rows: TimelineRow[];
  hasMore: boolean;
  loading: boolean;
  /** True when the most recent page came from IndexedDB (no request). */
  servedFromCache: boolean;
  loadMore: () => void;
  /**
   * Take the rows the live window just dropped off its old end, so the two
   * arrays the timeline concatenates keep meeting. See shedRows.
   */
  absorb: (shed: TimelineRow[]) => void;
  reset: () => void;
};

function toCachedRows(rows: TimelineRow[], sessionId: string): CachedFullRow[] {
  return rows.map((r) => ({
    id: r.id,
    sessionId,
    role: r.role,
    content: r.content,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString(),
    authoredBy: r.authoredBy ?? null,
  }));
}

/**
 * @param sessionId       the open session
 * @param windowOldest    id of the oldest row in the LIVE window — the point
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

  // Fetch the page strictly before `before` into the digest cache, WITHOUT
  // touching the timeline. Cache-first: if the store already holds a whole page,
  // there is nothing to do. This is what keeps the reader one page ahead of
  // their next scroll.
  const warmPageBefore = useCallback(
    async (before: { id: string; createdAt: string }): Promise<void> => {
      const scope = currentScope();
      if (!scope) return;
      for (const read of [getFullRows, getDigestRows]) {
        if (pageBefore(await read(scope, sessionId), before, OLDER_PAGE)) return;
      }
      const res = await utils.client.chat.listMessagesBefore.query({
        sessionId,
        beforeId: before.id,
        limit: OLDER_PAGE,
        digest: true,
      });
      if (res.rows.length === 0) return;
      await putDigestRows(scope, sessionId, toCachedRows(res.rows, sessionId), before.id);
    },
    [sessionId, utils]
  );

  const loadMore = useCallback(() => {
    if (inFlight.current || !anchorId) return;
    inFlight.current = true;
    setLoading(true);
    void (async () => {
      try {
        const scope = currentScope();
        let page: TimelineRow[] | null = null;
        let fromCache = false;
        // null until a SERVER page answers — a cache hit cannot say whether more
        // history lies behind it.
        let more: boolean | null = null;

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
          const before = { createdAt: anchorAt, id: anchorId };
          for (const read of [getFullRows, getDigestRows]) {
            const cached = pageBefore(await read(scope, sessionId), before, OLDER_PAGE);
            if (cached) {
              page = cached;
              fromCache = true;
              break;
            }
          }
        }

        // ── server ───────────────────────────────────────────────────────────
        // Digested: the collapsed timeline shows tool NAMES and first lines, and
        // three quarters of an undigested page is tool output nobody paints.
        // Opening a capsule fetches its real bodies (chat.getMessages).
        if (!page) {
          const res = await utils.client.chat.listMessagesBefore.query({
            sessionId,
            beforeId: anchorId,
            limit: OLDER_PAGE,
            digest: true,
          });
          // A page that came back empty is the beginning of the session, whatever
          // else anyone claims. Trusting only the reported flag is how a button
          // ends up pulling forever: it stays offered, every scroll at the top
          // fires another pull, each returns nothing, and the label flickers
          // between "loading…" and "↑ load earlier" without the list moving.
          more = res.hasMore && res.rows.length > 0;
          if (res.rows.length > 0) {
            page = res.rows;
            // Persist so the NEXT walk back through this history needs no network.
            // Into `digest`, not `full`: these rows have had their tool bodies
            // trimmed, and writing them into the store the LIVE window is served
            // from would let a first paint come back missing what it used to show.
            if (scope) {
              void putDigestRows(scope, sessionId, toCachedRows(res.rows, sessionId), anchorId).catch(() => {});
            }
          }
        }

        // ── commit in chunks ────────────────────────────────────────────────
        // The whole page lands in 30-row slices, newest first, with a frame
        // between slices. Each slice's markdown + highlight parse stays under a
        // frame, and the prepend anchor re-asserts between slices, so the reader
        // never sees more than one slice of displacement.
        if (page && page.length > 0) {
          const chunks = chunksBottomFirst(page, COMMIT_CHUNK);
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            setRows((prev) => [...chunk, ...prev]);
            if (i < chunks.length - 1) await nextFrame();
          }
        }

        setServedFromCache(fromCache);
        if (more !== null) setSaysMore(more);

        // ── leading-page prefetch ────────────────────────────────────────────
        // The next scroll should find its page already in the cache. This is the
        // interactive counterpart to the whole-session warm below: it runs only
        // when the reader actually scrolls, and guarantees they never wait at a
        // seam.
        if (scope && page && page.length > 0) {
          const first = page[0];
          const nextBefore = {
            id: first.id,
            createdAt: typeof first.createdAt === 'string' ? first.createdAt : first.createdAt.toISOString(),
          };
          void warmPageBefore(nextBefore).catch(() => {});
        }
      } catch {
        // Leave hasMore alone so the button stays and the user can retry.
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    })();
  }, [anchorId, anchorAt, sessionId, utils, warmPageBefore]);

  // ── Whole-session digest warm ─────────────────────────────────────────────
  //
  // Opening a session paints the live window and nothing else, and the live
  // window is 60 raw messages — which since tool chains started folding is far
  // less conversation than it used to be. So the first scroll up used to land
  // on a fetch. The leading-page prefetch above covers one page; this walks the
  // WHOLE history into the digest cache in the background so that, given a
  // moment, scrolling back through a session you have opened before is local
  // from the first row to the last.
  //
  // It starts from the oldest row already cached (full or digest), so re-opening
  // a session does not re-walk history it already holds. It stops when the
  // server reports the beginning, and is capped at WARM_MAX_PAGES so a 26k-
  // message session does not turn into an unbounded background crawl.
  // The warm walk reads its starting point and the "is there anything behind"
  // flag from refs, so a change to `saysMore`/`anchorId` (which happens the
  // moment the first server page answers, and would otherwise tear the effect
  // down and cancel the walk) never interrupts it. The walk is keyed on the
  // session alone.
  const warmAll = useRef<{ sessionId: string; cancelled: boolean } | null>(null);
  const warmEdgeRef = useRef<{ id: string; createdAt: string } | null>(null);
  const warmMayHaveMoreRef = useRef(false);
  // Sync the latest edge / more-flag into refs the walk reads. Done in an effect
  // (not during render) so the walk's values are always the freshest, while the
  // walk itself stays keyed on the session alone and is never torn down by a
  // change to `saysMore`/`anchorId`.
  useEffect(() => {
    warmEdgeRef.current = anchorId && anchorAt ? { id: anchorId, createdAt: anchorAt } : null;
    warmMayHaveMoreRef.current = saysMore ?? mayHaveMore;
  });
  useEffect(() => {
    if (warmAll.current?.sessionId === sessionId) return;
    const run = { sessionId, cancelled: false };
    warmAll.current = run;
    const walk = () => {
      void (async () => {
        try {
          if (!warmMayHaveMoreRef.current) return; // nothing behind this session
          const startEdge = warmEdgeRef.current;
          if (!startEdge) return;
          const scope = currentScope();
          if (!scope) return;
          // Oldest row across the two renderable stores, else the live window's
          // oldest. `full` holds the tail, `digest` the older pages; both are
          // sorted ascending, so index 0 is the oldest of each.
          let cursor = startEdge;
          const [fullRows, digestRows] = await Promise.all([
            getFullRows(scope, sessionId),
            getDigestRows(scope, sessionId),
          ]);
          for (const c of [fullRows[0], digestRows[0]]) {
            if (!c) continue;
            const at = c.createdAt;
            if (at < cursor.createdAt || (at === cursor.createdAt && c.id < cursor.id)) {
              cursor = { id: c.id, createdAt: at };
            }
          }
          for (let i = 0; i < WARM_MAX_PAGES; i++) {
            if (run.cancelled || run.sessionId !== sessionId) return;
            const res = await utils.client.chat.listMessagesBefore.query({
              sessionId,
              beforeId: cursor.id,
              limit: WARM_BATCH,
              digest: true,
            });
            if (run.cancelled || run.sessionId !== sessionId) return;
            if (res.rows.length === 0) break;
            await putDigestRows(scope, sessionId, toCachedRows(res.rows, sessionId), cursor.id);
            const first = res.rows[0];
            cursor = {
              id: first.id,
              createdAt: typeof first.createdAt === 'string' ? first.createdAt : first.createdAt.toISOString(),
            };
            if (!res.hasMore) break;
            await sleep(WARM_GAP_MS);
          }
          // Keep the digest store inside its LRU once this walk has grown it.
          void evictFullLru(scope).catch(() => {});
        } catch {
          /* a warm page is an optimisation; failing to get one is not an error */
        }
      })();
    };
    const timer = setTimeout(walk, WARM_DELAY_MS);
    return () => {
      run.cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, utils]);

  const absorb = useCallback((shed: TimelineRow[]) => {
    setRows((prev) => absorbShed(prev, shed));
  }, []);

  const reset = useCallback(() => {
    setRows([]);
    setSaysMore(null);
    setServedFromCache(false);
    warmAll.current = null;
  }, []);

  return {
    rows,
    // Until a page has been served and answered for itself, trust the seed.
    hasMore: saysMore ?? mayHaveMore,
    loading,
    servedFromCache,
    loadMore,
    absorb,
    reset,
  };
}
