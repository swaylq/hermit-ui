'use client';

// Owns the in-memory search corpus and answers queries against it.
//
// WHY NOT A WEB WORKER — that was the first design, and it does not survive
// contact with the bundler: Turbopack (Next 16) does not compile
// `new Worker(new URL('./x.ts', import.meta.url))` into a worker chunk. It
// copies the TypeScript file into .next/static/media verbatim, so the browser
// fetches raw TS, fails to parse it, and every session pays a doomed request
// plus a console error before falling back. Shipping a path that always errors
// first is worse than not shipping it.
//
// Main-thread is affordable here because of the two things that dominate cost:
//   · Loading the corpus is sliced (db.streamAllText) so the multi-megabyte
//     structured-clone deserialization never blocks one long frame.
//   · Scanning is ~10-30 ms over the current ~11 MB corpus, behind a 120 ms
//     debounce — one keystroke's work, not a freeze.
// And usually there's nothing to load at all: the sync engine pushes rows in as
// it fetches them, so a warm tab already holds the corpus.
//
// If the corpus ever outgrows this, search-core.ts is the only thing that has to
// change — an inverted index behind the same `search()` call.

import { streamAllText } from './db';
import { searchCorpus, toEntry, type CorpusEntry, type SearchOptions } from './search-core';
import type { CachedText, SearchResult } from './types';

// How often corpus changes are announced. The sync writes a batch every few
// hundred milliseconds during a backfill; notifying per batch would re-run an
// open search that often. One notification per second keeps an open search
// visibly converging without turning the backfill into a search storm.
const NOTIFY_THROTTLE_MS = 1000;

class SearchClient {
  private corpus = new Map<string, CorpusEntry>();
  private view: CorpusEntry[] | null = null;
  private loadedScope: string | null = null;
  private loading: Promise<void> | null = null;
  // Bumped whenever the corpus content changes. Subscribers re-run their search
  // against the larger corpus — without this, a search issued while the cache is
  // still filling would answer from a partial corpus and never correct itself
  // (the answer is memoized per query, so it would sit at a wrong, low count
  // until the user retyped). That was a real bug, not a hypothetical: a search
  // during the initial backfill reported 0 matches for a session holding 1489
  // cached messages.
  private version = 0;
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyPending = false;

  getVersion(): number {
    return this.version;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.view = null;
    this.version++;
    if (this.notifyTimer) {
      this.notifyPending = true;
      return;
    }
    for (const fn of this.listeners) fn();
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      if (this.notifyPending) {
        this.notifyPending = false;
        this.changed();
      }
    }, NOTIFY_THROTTLE_MS);
  }

  private entries(): CorpusEntry[] {
    if (!this.view) this.view = [...this.corpus.values()];
    return this.view;
  }

  /** Load (or re-load) the corpus for a workspace scope. Idempotent; concurrent
   *  callers share one load. */
  async load(scope: string): Promise<void> {
    if (this.loadedScope === scope) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      // Read into a staging map rather than clearing in place: a concurrent
      // sync is calling upsert() the whole time, and wiping the live corpus
      // first would drop whatever it delivered mid-read.
      const staged = new Map<string, CorpusEntry>();
      const n = await streamAllText(scope, (rows) => {
        for (const r of rows) staged.set(r.id, toEntry(r));
      });
      // A null count means IndexedDB was unavailable (blocked by another tab's
      // upgrade, private mode, evicted). Do NOT latch the scope as loaded —
      // that would leave an empty corpus permanently marked complete and every
      // search answering "no matches" until a page reload.
      if (n === null) return;
      // Rows that arrived from the sync while we were reading win: they're at
      // least as fresh as what was on disk.
      for (const [id, entry] of this.corpus) staged.set(id, entry);
      this.corpus = staged;
      this.loadedScope = scope;
      this.changed();
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /** Push freshly-synced rows into the live corpus, so a sync in progress makes
   *  its results searchable immediately rather than after a reload. */
  upsert(rows: CachedText[]): void {
    if (rows.length === 0) return;
    for (const r of rows) this.corpus.set(r.id, toEntry(r));
    this.changed();
  }

  dropSession(sessionId: string): void {
    let removed = false;
    for (const [id, entry] of this.corpus) {
      if (entry.row.sessionId === sessionId) {
        this.corpus.delete(id);
        removed = true;
      }
    }
    if (removed) this.changed();
  }

  search(query: string, opts: SearchOptions = {}): SearchResult {
    return searchCorpus(this.entries(), query, opts);
  }

  /** Workspace switch / sign-out: forget everything held in memory. */
  reset(): void {
    this.corpus.clear();
    this.loadedScope = null;
    this.changed();
  }
}

let singleton: SearchClient | null = null;

export function getSearchClient(): SearchClient {
  if (!singleton) singleton = new SearchClient();
  return singleton;
}
