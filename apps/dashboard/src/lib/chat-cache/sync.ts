'use client';

// The sync engine: keeps the browser's prose cache level with the server.
//
// PROTOCOL
//   1. chat.syncProbe → one row per session with messages: {watermark, count}.
//   2. Diff against what's cached:
//        · unknown session, or watermark moved  → fetch the delta
//        · count mismatch                       → drop + full resync (a row was
//          deleted; a watermark can't see that)
//        · cached but absent from the probe     → session deleted, drop it
//   3. chat.syncText pages the delta with a (updatedAt, id) cursor.
//   4. Rows land in IndexedDB and are pushed straight into the live search
//      corpus, so it never has to be re-read from disk mid-session.
//
// It is a module singleton, not a hook: the sync must survive route changes and
// must not run once per mounted component. `useChatCacheSync` just starts it.
//
// It is also deliberately unhurried. Sessions are synced one at a time with a
// gap between them; this is background work behind a live chat UI, and the
// server it's polling is the same one streaming the user's current turn.

import { getActiveEntry } from '@/lib/keyring';
import { authedFetch } from '@/lib/asst-fetch';
import type { CachedText, CachedSession } from './types';
import { planSync, type ProbeRow } from './sync-plan';
import { scopeId, putTextRows, getSessions, putSession, dropSession, pruneForeignScopes, requestPersistence } from './db';
import { getSearchClient } from './search-client';

const PAGE_LIMIT = 1000;
// Between sessions during a backfill. Keeps a cold start off the critical path
// of whatever the user is actually doing.
const SESSION_GAP_MS = 120;
const POLL_MS = 30_000;

export type { ProbeRow, SyncPlan } from './sync-plan';

type SyncTextResponse = {
  rows: CachedText[];
  cursor: { since: number; afterId: string } | null;
  done: boolean;
};

// Minimal tRPC query over plain fetch. Both endpoints it calls return primitives
// only, so superjson's envelope is just `{json}` with no `meta` to decode.
async function trpcQuery<T>(path: string, input: unknown, signal?: AbortSignal): Promise<T> {
  const url = `/api/trpc/${path}?batch=1&input=${encodeURIComponent(JSON.stringify({ '0': { json: input } }))}`;
  const r = await authedFetch(url, { signal });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  const j = await r.json();
  const err = j?.[0]?.error;
  if (err) throw new Error(err?.json?.message ?? `${path} failed`);
  return j?.[0]?.result?.data?.json as T;
}

export type SyncStatus = {
  state: 'idle' | 'syncing' | 'ready' | 'unavailable';
  // Sessions whose prose is fully cached, out of the sessions the server reports.
  syncedSessions: number;
  totalSessions: number;
  cachedMessages: number;
  lastError: string | null;
};

type Listener = (s: SyncStatus) => void;

class ChatCacheSync {
  private scope: string | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** A poll that came due while the tab was hidden, owed on the way back. */
  private deferred = false;
  private onVisible: (() => void) | null = null;
  private abort: AbortController | null = null;
  private listeners = new Set<Listener>();
  private status: SyncStatus = {
    state: 'idle',
    syncedSessions: 0,
    totalSessions: 0,
    cachedMessages: 0,
    lastError: null,
  };

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }

  // Resolve the active workspace's cache scope. Returns null when there's no key
  // yet (the landing page before a machine is added).
  private resolveScope(): string | null {
    const entry = getActiveEntry();
    if (!entry) return null;
    return scopeId(entry.id, entry.scoped ? entry.agentName : null);
  }

  start(): void {
    const scope = this.resolveScope();
    if (!scope) return;
    if (this.scope && this.scope !== scope) this.stop(); // workspace switched
    this.scope = scope;
    if (this.running) return;
    this.running = true;
    // A hidden tab has nobody to show a fresher cache to, and this poll is not
    // cheap on the other end: `chat.syncProbe` groups EVERY message on the
    // machine to answer "what changed", which is a parallel sequential scan —
    // 24ms of wall time over 101,658 rows on a local fixture, and it ran every
    // 30s in every open tab whether or not anyone was looking. Browsers throttle
    // background timers, but not reliably and not to zero, and the cost here is
    // the server's, not the timer's.
    //
    // So: stop scheduling while hidden, and remember that one was owed. Coming
    // back runs it immediately, which is also what makes this safe — the cache
    // is never more stale than the moment the tab is looked at again.
    if (typeof document !== 'undefined' && !this.onVisible) {
      this.onVisible = () => {
        if (!this.running || document.hidden) return;
        if (!this.deferred) return;
        this.deferred = false;
        void this.tick();
      };
      document.addEventListener('visibilitychange', this.onVisible);
    }
    void requestPersistence();
    void this.housekeep();
    // The FIRST tick waits for idle: it runs the server-side syncProbe (a
    // groupBy over every message on the machine) plus the IndexedDB pass, and
    // firing it the moment the page loads makes both compete with first paint
    // and hydration. The steady-state poll below is unchanged. A 3s fallback
    // covers browsers without requestIdleCallback (Safari) — bounded, so the
    // cache can never be starved by a busy main thread.
    const w = typeof window !== 'undefined'
      ? (window as unknown as { requestIdleCallback?: (cb: () => void) => void })
      : {};
    (w.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 3000)))(() => void this.tick());
  }

  stop(): void {
    this.running = false;
    this.deferred = false;
    if (this.onVisible && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisible);
    }
    this.onVisible = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
    getSearchClient().reset();
  }

  // Delete cache databases belonging to workspaces no longer in the keyring.
  private async housekeep(): Promise<void> {
    try {
      const { getKeyring } = await import('@/lib/keyring');
      const live = getKeyring().map((e) => scopeId(e.id, e.scoped ? e.agentName : null));
      await pruneForeignScopes(live);
    } catch {
      // best effort
    }
  }

  private schedule(ms: number) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof document !== 'undefined' && document.hidden) {
      // Owed, not armed. `onVisible` above pays it back.
      this.deferred = true;
      return;
    }
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** Run one full probe → reconcile pass. Safe to call at any time. */
  async tick(): Promise<void> {
    if (!this.running || !this.scope) return;
    // A timer armed before the tab was hidden can still land after it. Same
    // rule: owe it, do not spend it.
    if (typeof document !== 'undefined' && document.hidden) {
      this.deferred = true;
      return;
    }
    const scope = this.scope;
    this.abort?.abort();
    this.abort = new AbortController();
    const { signal } = this.abort;
    try {
      this.emit({ state: 'syncing', lastError: null });
      const probe = await trpcQuery<ProbeRow[]>('chat.syncProbe', null, signal);
      const plan = planSync(probe, await getSessions(scope));

      for (const id of plan.drop) {
        await dropSession(scope, id);
        getSearchClient().dropSession(id);
      }

      let synced = plan.upToDate.length;
      let messages = plan.upToDate.reduce((n, p) => n + p.count, 0);
      this.emit({ totalSessions: probe.length, syncedSessions: synced, cachedMessages: messages });

      for (const job of plan.fetch) {
        if (signal.aborted || !this.running) return;
        if (job.reset) {
          await dropSession(scope, job.probe.sessionId);
          getSearchClient().dropSession(job.probe.sessionId);
        }
        const ok = await this.syncSession(scope, job.probe, { since: job.since }, signal);
        if (ok) {
          synced++;
          messages += job.probe.count;
        }
        this.emit({ syncedSessions: synced, cachedMessages: messages });
        await sleep(SESSION_GAP_MS, signal);
      }

      this.emit({ state: 'ready', syncedSessions: synced, totalSessions: probe.length, cachedMessages: messages });
    } catch (e) {
      if (signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.emit({ state: this.status.syncedSessions > 0 ? 'ready' : 'unavailable', lastError: msg });
    } finally {
      this.schedule(POLL_MS);
    }
  }

  // Page one session's delta to completion. The watermark is only committed
  // AFTER the last page lands, so an interrupted sync resumes from the last
  // known-good point instead of skipping the middle.
  private async syncSession(
    scope: string,
    probe: ProbeRow,
    from: { since: number; afterId?: string },
    signal: AbortSignal
  ): Promise<boolean> {
    let cursor: { since: number; afterId?: string } = from;
    for (let page = 0; page < 200; page++) {
      if (signal.aborted) return false;
      const res = await trpcQuery<SyncTextResponse>(
        'chat.syncText',
        { sessionId: probe.sessionId, since: cursor.since, afterId: cursor.afterId, limit: PAGE_LIMIT },
        signal
      );
      if (res.rows.length > 0) {
        await putTextRows(scope, res.rows);
        getSearchClient().upsert(res.rows);
      }
      if (res.done || !res.cursor) break;
      cursor = res.cursor;
    }
    const next: CachedSession = {
      sessionId: probe.sessionId,
      agentName: probe.agentName,
      title: probe.title,
      preview: probe.preview,
      watermark: probe.watermark,
      count: probe.count,
    };
    await putSession(scope, next);
    return true;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

let singleton: ChatCacheSync | null = null;

export function getChatCacheSync(): ChatCacheSync {
  if (!singleton) singleton = new ChatCacheSync();
  return singleton;
}

// Re-exported so the existing callers keep their import path; it lives in db.ts
// now because translate-store needs a scope without pulling in this module.
export { currentScope } from './db';
