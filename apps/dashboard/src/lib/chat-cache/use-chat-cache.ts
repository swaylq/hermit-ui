'use client';

// React bindings for the chat cache. Everything stateful lives in the module
// singletons (sync.ts, search-client.ts); these hooks only wire them to
// component lifetimes.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getChatCacheSync, currentScope, type SyncStatus } from './sync';
import { getSearchClient } from './search-client';
import { getFullRows, putFullRows, evictFullLru, getSessions } from './db';
import type { CachedFullRow, CachedSession, SearchResult } from './types';
import type { SearchOptions } from './search-core';

const IDLE: SyncStatus = { state: 'idle', syncedSessions: 0, totalSessions: 0, cachedMessages: 0, lastError: null };

/**
 * Start (and keep running) the background sync. Mount ONCE, high in the tree.
 * Re-syncs when the tab regains focus so a phone waking up is current before the
 * user can type.
 */
export function useChatCacheSync(): SyncStatus {
  const status = useSyncExternalStore(
    useCallback((cb: () => void) => getChatCacheSync().subscribe(cb), []),
    () => getChatCacheSync().getStatus(),
    () => IDLE
  );

  useEffect(() => {
    const engine = getChatCacheSync();
    engine.start();
    const onFocus = () => {
      if (document.visibilityState === 'visible') {
        engine.start();
        void engine.tick();
      }
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return status;
}

/**
 * Debounced search over the cached prose. `opts` is captured by value on every
 * render, so callers can pass an object literal without re-triggering.
 *
 * The settled query is stored ALONGSIDE its result, which makes both outputs
 * derivable: a result belongs to the current query or it isn't shown, and
 * "searching" is simply "the settled query isn't the current one yet". No
 * separate flag to keep in sync, and no stale result can flash for a query the
 * user has already changed.
 */
export function useChatSearch(query: string, opts: SearchOptions = {}, debounceMs = 120) {
  const [settled, setSettled] = useState<{ q: string; v: number; result: SearchResult | null }>({
    q: '',
    v: -1,
    result: null,
  });
  const q = query.trim();
  const optsKey = JSON.stringify(opts);
  const seq = useRef(0);

  // Re-run when the corpus grows. On a cold start the sync is still backfilling
  // while the user types, so the first answer is computed over a partial corpus;
  // without this the count would freeze at that partial answer until the query
  // text changed. The client throttles its notifications, so this converges in
  // about a second per batch rather than thrashing.
  const corpusVersion = useSyncExternalStore(
    useCallback((cb: () => void) => getSearchClient().subscribe(cb), []),
    () => getSearchClient().getVersion(),
    () => 0
  );

  useEffect(() => {
    if (!q) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const scope = currentScope();
      let r: SearchResult | null = null;
      if (scope) {
        try {
          const client = getSearchClient();
          await client.load(scope);
          r = client.search(q, JSON.parse(optsKey) as SearchOptions);
        } catch {
          r = null; // cache unavailable — settle empty rather than spin forever
        }
      }
      if (seq.current === mine) setSettled({ q, v: getSearchClient().getVersion(), result: r });
    }, debounceMs);
    return () => clearTimeout(t);
  }, [q, optsKey, debounceMs, corpusVersion]);

  return {
    // Only the answer for the CURRENT query is shown; an older query's result is
    // never displayed against newer input.
    result: q && settled.q === q ? settled.result : null,
    // Still working if the query hasn't settled at all, or settled against an
    // older corpus than the one now loaded.
    searching: !!q && (settled.q !== q || settled.v < corpusVersion),
  };
}

/**
 * Session metadata (agent, title) keyed by id, so a search hit can be labelled
 * without a network call. Refreshed whenever the sync engine reports progress —
 * that's exactly when a new session could have appeared.
 */
export function useCachedSessionMeta(): Map<string, CachedSession> {
  const status = useChatCacheSyncStatus();
  const [meta, setMeta] = useState<Map<string, CachedSession>>(() => new Map());
  const stamp = `${status.totalSessions}:${status.syncedSessions}`;
  useEffect(() => {
    let alive = true;
    const scope = currentScope();
    if (!scope) return;
    void getSessions(scope).then((rows) => {
      if (alive) setMeta(new Map(rows.map((r) => [r.sessionId, r])));
    });
    return () => {
      alive = false;
    };
  }, [stamp]);
  return meta;
}

/**
 * The cached timeline for a session, for first paint. `null` means "not looked
 * up yet"; `[]` means "looked up, nothing cached" — the caller must distinguish
 * the two or it will flash an empty conversation.
 */
export function useCachedTimeline(sessionId: string | null): CachedFullRow[] | null {
  // The loaded session is stored WITH its rows, so switching sessions derives
  // back to null instead of needing a synchronous reset inside the effect.
  const [loaded, setLoaded] = useState<{ sessionId: string; rows: CachedFullRow[] } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void (async () => {
      await Promise.resolve(); // never settle synchronously within the effect body
      const scope = currentScope();
      const rows = scope ? await getFullRows(scope, sessionId) : [];
      if (alive) setLoaded({ sessionId, rows });
    })();
    return () => {
      alive = false;
    };
  }, [sessionId]);
  return sessionId && loaded?.sessionId === sessionId ? loaded.rows : null;
}

/**
 * Write-through: persist whatever the timeline just rendered so the next open of
 * this session paints from disk. Debounced, because during a live turn the row
 * list changes several times a second and only the final shape is worth storing.
 */
export function useTimelineWriteThrough(
  sessionId: string | null,
  rows:
    | Array<{
        id: string;
        role: string;
        content: unknown;
        createdAt: Date | string;
        authoredBy?: string | null;
      }>
    | undefined
): void {
  const sig = rows ? `${rows.length}:${rows[rows.length - 1]?.id ?? ''}` : '';
  useEffect(() => {
    if (!sessionId || !rows || rows.length === 0) return;
    const scope = currentScope();
    if (!scope) return;
    const t = setTimeout(() => {
      const payload: CachedFullRow[] = rows.map((r) => ({
        id: r.id,
        sessionId,
        role: r.role,
        content: r.content,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString(),
        authoredBy: r.authoredBy ?? null,
      }));
      // Swallow failures explicitly. This is a cache: a quota overrun, an
      // aborted transaction, or a value the structured-clone algorithm rejects
      // must degrade to "the next open hits the network", not to an unhandled
      // rejection — which is both noisy and, because it aborts the chain, stops
      // the LRU eviction that keeps this store bounded.
      void putFullRows(scope, sessionId, payload)
        .then(() => evictFullLru(scope))
        .catch(() => {});
    }, 1_500);
    return () => clearTimeout(t);
    // `sig` stands in for `rows`: a new array identity every poll tick would
    // restart the debounce forever and nothing would ever be written.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sig]);
}

/** Human-readable coverage line for the search UI. */
export function coverageLabel(s: SyncStatus): string | null {
  if (s.state === 'unavailable') return '本地缓存不可用，搜索仅覆盖已加载的内容';
  if (s.state === 'syncing' && s.totalSessions > 0 && s.syncedSessions < s.totalSessions) {
    return `正在建立本地索引… ${s.syncedSessions}/${s.totalSessions} 个会话`;
  }
  return null;
}

export function useChatCacheSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    useCallback((cb: () => void) => getChatCacheSync().subscribe(cb), []),
    () => getChatCacheSync().getStatus(),
    () => IDLE
  );
}
