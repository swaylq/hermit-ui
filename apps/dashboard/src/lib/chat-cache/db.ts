// IndexedDB layer for the browser-local chat cache.
//
// Hand-rolled rather than pulling in idb/Dexie: the surface we need is ~8
// operations, and the dashboard has no client-storage dependency today.
//
// SCOPING — the database name carries the workspace identity (machine id, plus
// the agent name for a scoped share key). Switching workspaces therefore opens a
// DIFFERENT database; it can't read the previous one, and `pruneForeignScopes`
// deletes the ones that no longer correspond to a keyring entry. This is a
// convenience boundary, not the security boundary — the server still scopes
// every query by the request's key (see agentProcedure). It exists so a shared
// link opened on someone's laptop doesn't leave another agent's prose behind in
// their browser.
//
// EVERYTHING here fails soft. Private-browsing modes, disabled storage, and iOS
// eviction all surface as exceptions from `indexedDB.open`; callers get empty
// results and the UI falls back to server-side behavior rather than breaking.

import { getActiveEntry } from '@/lib/keyring';
import type { CachedText, CachedSession, CachedFullRow, FullMeta, CachedTranslation } from './types';

const DB_PREFIX = 'hermit-chat-cache';
// 2: `text` rows gained `blocks`, so interaction cards survive in cache-served
// history. The projection changed, not the schema — but a delta sync only
// refetches what MOVED, so old rows would keep their old shape forever. Wiping
// the bookkeeping on upgrade makes the next pass a full refetch (~11 MB,
// background, behind the usual "正在建立本地索引…" line).
// 3: added the `digest` store — history pages as the collapsed timeline renders
// them. Purely additive; nothing already cached changes meaning.
// 4: added the `translations` store. Also purely additive. NOTE: entries are
// keyed by source text + target language only, NOT by which model produced
// them — so changing DASHSCOPE_TRANSLATE_MODEL leaves the old translations in
// place. They stay valid translations, just from the previous model; bump this
// version if a model change ever needs to invalidate them.
// 5: added the `heights` store. Purely additive again. One record per session
// and column width, holding every row height that has been measured at that
// width — so re-opening a conversation does not start by guessing the size of
// rows it has already displayed once.
const DB_VERSION = 5;

export const STORE_TEXT = 'text';
export const STORE_SESSIONS = 'sessions';
export const STORE_FULL = 'full';
export const STORE_FULL_META = 'fullMeta';
// History pages in their DIGESTED form: tool arguments trimmed to the preview
// the collapsed capsule shows, results to their first line, thinking to its
// length (server/message-digest.ts). Roughly 5% of what `full` costs per row,
// which is what lets a second walk back through a long session be free.
export const STORE_DIGEST = 'digest';
// Translated markdown blocks, keyed by a hash of the source text plus the
// target language. Reading these back is what stops a reload re-buying every
// translation on screen.
export const STORE_TRANSLATIONS = 'translations';
// Measured row heights, one record per (session, column width). The windowed
// timeline has to know how tall rows it has never mounted are, and everything
// it has not measured is an estimate that gets corrected — visibly — the moment
// the row appears. A height that was measured once is the one thing that never
// needs estimating again, so it is worth keeping.
export const STORE_HEIGHTS = 'heights';

// How many sessions keep their full (renderable) rows. The prose layer covers
// every session; this one only makes RE-opening a session instant, so a handful
// of recents is the whole benefit. 15 sessions of median size (~390 messages)
// is a few MB.
export const FULL_LRU_SESSIONS = 15;

// How many translated blocks to keep. Paragraph-sized entries, so this is a
// couple of MB at worst — small beside the ~11 MB prose layer, and far more
// than one reader gets through in a session. Trimmed back to KEEP after it is
// exceeded, so eviction runs rarely rather than on every write.
export const TRANSLATION_LRU_MAX = 6_000;
export const TRANSLATION_LRU_KEEP = 4_500;

export function scopeId(machineId: string, agentName?: string | null): string {
  return agentName ? `${machineId}::${agentName}` : machineId;
}

/**
 * Which cache database the active keyring entry maps to, or null when there is
 * no workspace selected yet.
 *
 * Lives here rather than in sync.ts so that reaching for a scope does not drag
 * the sync engine — and with it the search worker — into a caller that only
 * wants to read one store.
 */
export function currentScope(): string | null {
  const entry = getActiveEntry();
  if (!entry) return null;
  return scopeId(entry.id, entry.scoped ? entry.agentName : null);
}

function dbName(scope: string): string {
  return `${DB_PREFIX}:${scope}`;
}

export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false; // some embedded webviews throw on mere property access
  }
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

// One connection per scope, reused. A `versionchange` from another tab closes it
// so that tab's upgrade isn't blocked; the next call reopens.
const openDbs = new Map<string, Promise<IDBDatabase | null>>();

const ALL_STORES = [STORE_TEXT, STORE_SESSIONS, STORE_FULL, STORE_FULL_META, STORE_DIGEST, STORE_TRANSLATIONS, STORE_HEIGHTS];

function createMissingStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_TEXT)) {
    db.createObjectStore(STORE_TEXT, { keyPath: 'id' }).createIndex('by_session', 'sessionId');
  }
  if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
    db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionId' });
  }
  if (!db.objectStoreNames.contains(STORE_FULL)) {
    db.createObjectStore(STORE_FULL, { keyPath: 'id' }).createIndex('by_session', 'sessionId');
  }
  if (!db.objectStoreNames.contains(STORE_FULL_META)) {
    db.createObjectStore(STORE_FULL_META, { keyPath: 'sessionId' });
  }
  if (!db.objectStoreNames.contains(STORE_DIGEST)) {
    db.createObjectStore(STORE_DIGEST, { keyPath: 'id' }).createIndex('by_session', 'sessionId');
  }
  if (!db.objectStoreNames.contains(STORE_TRANSLATIONS)) {
    db.createObjectStore(STORE_TRANSLATIONS, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORE_HEIGHTS)) {
    db.createObjectStore(STORE_HEIGHTS, { keyPath: 'key' });
  }
}

function openAt(scope: string, version: number | undefined): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = version === undefined ? indexedDB.open(dbName(scope)) : indexedDB.open(dbName(scope), version);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = (e) => {
      const db = req.result;
      createMissingStores(db);
      // Re-derive everything projected by a previous version.
      if ((e as IDBVersionChangeEvent).oldVersion > 0 && (e as IDBVersionChangeEvent).oldVersion < 2) {
        const tx = req.transaction;
        if (tx) {
          for (const store of [STORE_TEXT, STORE_SESSIONS]) {
            if (db.objectStoreNames.contains(store)) tx.objectStore(store).clear();
          }
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        openDbs.delete(scope);
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

export function openCache(scope: string): Promise<IDBDatabase | null> {
  const existing = openDbs.get(scope);
  if (existing) return existing;
  const p = (async (): Promise<IDBDatabase | null> => {
    if (!idbAvailable()) return null;
    const db = await openAt(scope, DB_VERSION);
    if (!db) return null;
    if (ALL_STORES.every((s) => db.objectStoreNames.contains(s))) return db;
    // The database exists at our version but is missing stores — it was created
    // by something other than this code path (a devtools poke, an interrupted
    // first upgrade, another tool opening it version-less before we ever ran).
    // `onupgradeneeded` will never fire again at the same version, so the cache
    // would be permanently inert. Bump the version to force one more upgrade.
    const bumped = db.version + 1;
    db.close();
    const healed = await openAt(scope, bumped);
    if (!healed) return null;
    return ALL_STORES.every((s) => healed.objectStoreNames.contains(s)) ? healed : null;
  })();
  openDbs.set(scope, p);
  // NEVER memoize a failure. An upgrade blocked by another tab's open handle,
  // or any transient open error, resolves null — and caching that null would
  // leave the cache dead for the rest of the page's life, with the next call
  // happily returning the same failure instead of retrying. Forgetting it means
  // the next sync tick (30s) or the next search simply tries again.
  void p.then((db) => {
    if (!db && openDbs.get(scope) === p) openDbs.delete(scope);
  });
  return p;
}

// ── prose layer (full history) ───────────────────────────────────────────────

export async function putTextRows(scope: string, rows: CachedText[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await openCache(scope);
  if (!db) return;
  const tx = db.transaction(STORE_TEXT, 'readwrite');
  const store = tx.objectStore(STORE_TEXT);
  for (const r of rows) store.put(r);
  await txDone(tx);
}

export async function getAllText(scope: string): Promise<CachedText[]> {
  const db = await openCache(scope);
  if (!db) return [];
  const tx = db.transaction(STORE_TEXT, 'readonly');
  const rows = await promisify(tx.objectStore(STORE_TEXT).getAll() as IDBRequest<CachedText[]>);
  return rows ?? [];
}

// How many rows one `getAll` slice pulls. Small enough that deserializing a
// batch stays a few milliseconds; large enough that ~20k rows is ~20 round trips.
const READ_BATCH = 1000;

/**
 * Stream the prose store in key-ordered slices, handing each batch to `onBatch`
 * and yielding to the event loop in between.
 *
 * A single `getAll()` over ~20k rows structured-clones several megabytes in one
 * synchronous deserialization — hundreds of milliseconds of frozen UI on a
 * phone. Slicing turns that into ~20 short tasks the browser can interleave with
 * painting, so building the search corpus never blocks a frame for long. The
 * store's keyPath is the message id (a cuid — lexicographically orderable), so
 * `lowerBound(lastId, exclusive)` walks the whole store exactly once with no
 * cursor held open across an await.
 *
 * Returns the row count, or NULL if the database could not be opened at all.
 * The distinction matters: callers cache "this scope is loaded", and latching
 * that on an unavailable database would leave an empty corpus permanently
 * marked as complete — search would then answer "no matches" forever.
 */
export async function streamAllText(
  scope: string,
  onBatch: (rows: CachedText[]) => void,
  batchSize = READ_BATCH
): Promise<number | null> {
  const db = await openCache(scope);
  if (!db) return null;
  let total = 0;
  let lowerExclusive: string | null = null;
  for (;;) {
    const tx = db.transaction(STORE_TEXT, 'readonly');
    // Both annotations are required, not stylistic: `lowerExclusive` is assigned
    // from `rows` at the bottom of the loop, so without them TypeScript sees
    // range → rows → lowerExclusive → range and gives up with TS7022.
    const range: IDBKeyRange | null =
      lowerExclusive === null ? null : IDBKeyRange.lowerBound(lowerExclusive, true);
    const rows: CachedText[] = await promisify(
      tx.objectStore(STORE_TEXT).getAll(range, batchSize) as IDBRequest<CachedText[]>
    );
    if (!rows || rows.length === 0) return total;
    onBatch(rows);
    total += rows.length;
    if (rows.length < batchSize) return total;
    lowerExclusive = rows[rows.length - 1].id;
    // Let the browser paint before the next slice.
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

export async function getSessionText(scope: string, sessionId: string): Promise<CachedText[]> {
  const db = await openCache(scope);
  if (!db) return [];
  const tx = db.transaction(STORE_TEXT, 'readonly');
  const idx = tx.objectStore(STORE_TEXT).index('by_session');
  const rows = await promisify(idx.getAll(IDBKeyRange.only(sessionId)) as IDBRequest<CachedText[]>);
  return rows ?? [];
}

// Drop one session everywhere — used both when the server stops reporting a
// session (deleted) and when a count mismatch forces a clean resync.
export async function dropSession(scope: string, sessionId: string): Promise<void> {
  const db = await openCache(scope);
  if (!db) return;
  const tx = db.transaction([STORE_TEXT, STORE_SESSIONS, STORE_FULL, STORE_FULL_META, STORE_DIGEST], 'readwrite');
  // Every request is issued SYNCHRONOUSLY, then we await the transaction once.
  // Awaiting anything non-IDB mid-transaction lets it auto-commit out from under
  // the remaining work.
  tx.objectStore(STORE_SESSIONS).delete(sessionId);
  tx.objectStore(STORE_FULL_META).delete(sessionId);
  void deleteByIndex(tx.objectStore(STORE_TEXT), sessionId);
  void deleteByIndex(tx.objectStore(STORE_FULL), sessionId);
  void deleteByIndex(tx.objectStore(STORE_DIGEST), sessionId);
  await txDone(tx);
}

// Cursor-delete every row of one session. `getAllKeys` on the index then a
// keyed delete would need two round trips per row; a cursor walks it once.
function deleteByIndex(store: IDBObjectStore, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.index('by_session').openKeyCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      store.delete(cur.primaryKey);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// ── session bookkeeping ──────────────────────────────────────────────────────

export async function getSessions(scope: string): Promise<CachedSession[]> {
  const db = await openCache(scope);
  if (!db) return [];
  const tx = db.transaction(STORE_SESSIONS, 'readonly');
  const rows = await promisify(tx.objectStore(STORE_SESSIONS).getAll() as IDBRequest<CachedSession[]>);
  return rows ?? [];
}

export async function putSession(scope: string, session: CachedSession): Promise<void> {
  const db = await openCache(scope);
  if (!db) return;
  const tx = db.transaction(STORE_SESSIONS, 'readwrite');
  tx.objectStore(STORE_SESSIONS).put(session);
  await txDone(tx);
}

// ── rendered layer (LRU of recent sessions) ──────────────────────────────────

export async function getFullRows(scope: string, sessionId: string): Promise<CachedFullRow[]> {
  const db = await openCache(scope);
  if (!db) return [];
  const tx = db.transaction(STORE_FULL, 'readonly');
  const idx = tx.objectStore(STORE_FULL).index('by_session');
  const rows = await promisify(idx.getAll(IDBKeyRange.only(sessionId)) as IDBRequest<CachedFullRow[]>);
  if (!rows || rows.length === 0) return [];
  // Same ordering the timeline expects: (createdAt, id).
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

// Write-through from listMessages. Rows are upserted, never replace-all: the
// window the user is looking at is the NEWEST N, so a replace-all would throw
// away the older rows a previous "load earlier" already cached.
export async function putFullRows(scope: string, sessionId: string, rows: CachedFullRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await openCache(scope);
  if (!db) return;
  const tx = db.transaction([STORE_FULL, STORE_FULL_META], 'readwrite');
  const store = tx.objectStore(STORE_FULL);
  for (const r of rows) store.put(r);
  tx.objectStore(STORE_FULL_META).put({ sessionId, lastUsedAt: Date.now() } satisfies FullMeta);
  await txDone(tx);
}

// ── digested history layer ───────────────────────────────────────────────────
// Same shape as `full`, different fidelity. Written by "load earlier" once a
// page comes back from the server; read on the next walk back through the same
// history, which is then free. Shares the `full` LRU: a session evicted from one
// is evicted from the other, so there is one answer to "is this session cached".

export async function getDigestRows(scope: string, sessionId: string): Promise<CachedFullRow[]> {
  const db = await openCache(scope);
  if (!db) return [];
  const tx = db.transaction(STORE_DIGEST, 'readonly');
  const idx = tx.objectStore(STORE_DIGEST).index('by_session');
  const rows = await promisify(idx.getAll(IDBKeyRange.only(sessionId)) as IDBRequest<CachedFullRow[]>);
  if (!rows || rows.length === 0) return [];
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

export async function putDigestRows(scope: string, sessionId: string, rows: CachedFullRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await openCache(scope);
  if (!db) return;
  const tx = db.transaction([STORE_DIGEST, STORE_FULL_META], 'readwrite');
  const store = tx.objectStore(STORE_DIGEST);
  for (const r of rows) store.put(r);
  tx.objectStore(STORE_FULL_META).put({ sessionId, lastUsedAt: Date.now() } satisfies FullMeta);
  await txDone(tx);
}

// Keep the N most-recently-opened sessions' rendered rows; drop the rest. The
// prose layer is untouched, so evicted sessions stay fully searchable.
export async function evictFullLru(scope: string, keep = FULL_LRU_SESSIONS): Promise<number> {
  const db = await openCache(scope);
  if (!db) return 0;
  const metaTx = db.transaction(STORE_FULL_META, 'readonly');
  const metas = await promisify(metaTx.objectStore(STORE_FULL_META).getAll() as IDBRequest<FullMeta[]>);
  if (!metas || metas.length <= keep) return 0;
  const doomed = metas.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(keep);
  const tx = db.transaction([STORE_FULL, STORE_FULL_META, STORE_DIGEST], 'readwrite');
  const store = tx.objectStore(STORE_FULL);
  const digest = tx.objectStore(STORE_DIGEST);
  const meta = tx.objectStore(STORE_FULL_META);
  for (const m of doomed) {
    void deleteByIndex(store, m.sessionId); // issued synchronously — see dropSession
    void deleteByIndex(digest, m.sessionId);
    meta.delete(m.sessionId);
  }
  await txDone(tx);
  return doomed.length;
}

// ── translations ─────────────────────────────────────────────────────────────

/**
 * Look up many blocks at once, and stamp the ones found as used now so the LRU
 * measures "last read", not "last written" — a paragraph you scroll past every
 * day should outlive one translated once and never reopened.
 *
 * Returns only what was found; the caller pays the network for the rest.
 */
export async function getTranslations(scope: string, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  const db = await openCache(scope);
  if (!db) return out;
  try {
    const tx = db.transaction(STORE_TRANSLATIONS, 'readonly');
    const store = tx.objectStore(STORE_TRANSLATIONS);
    const rows = await Promise.all(keys.map((k) => promisify(store.get(k) as IDBRequest<CachedTranslation | undefined>)));
    for (const r of rows) if (r && typeof r.text === 'string') out.set(r.key, r.text);
  } catch {
    return out;
  }
  if (out.size) void touchTranslations(scope, [...out.keys()]);
  return out;
}

/** Refresh lastUsedAt. Fire-and-forget: a lost touch costs LRU accuracy only. */
async function touchTranslations(scope: string, keys: string[]): Promise<void> {
  const db = await openCache(scope);
  if (!db) return;
  try {
    const now = Date.now();
    const tx = db.transaction(STORE_TRANSLATIONS, 'readwrite');
    const store = tx.objectStore(STORE_TRANSLATIONS);
    for (const k of keys) {
      const req = store.get(k) as IDBRequest<CachedTranslation | undefined>;
      req.onsuccess = () => {
        const row = req.result;
        if (row) store.put({ ...row, lastUsedAt: now });
      };
    }
    await txDone(tx);
  } catch {
    /* fails soft, like everything else here */
  }
}

export async function putTranslations(scope: string, rows: CachedTranslation[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await openCache(scope);
  if (!db) return;
  try {
    const tx = db.transaction(STORE_TRANSLATIONS, 'readwrite');
    const store = tx.objectStore(STORE_TRANSLATIONS);
    for (const r of rows) store.put(r);
    await txDone(tx);
  } catch {
    /* quota, or the store vanished under us — the in-memory copy still serves */
  }
}

/**
 * Trim to `keep` least-recently-used. Deliberately not run on every write:
 * `max` gives it a band to work in, so a reader who never crosses it never
 * pays for a full scan.
 */
export async function evictTranslationsLru(
  scope: string,
  max = TRANSLATION_LRU_MAX,
  keep = TRANSLATION_LRU_KEEP,
): Promise<number> {
  const db = await openCache(scope);
  if (!db) return 0;
  try {
    const countTx = db.transaction(STORE_TRANSLATIONS, 'readonly');
    const store = countTx.objectStore(STORE_TRANSLATIONS);
    const n = await promisify(store.count() as IDBRequest<number>);
    if (n <= max) return 0;
    // Only the keys and their timestamps are needed to decide; pulling the
    // translations themselves would mean holding every cached paragraph in
    // memory at once just to throw most of them away.
    const rows = await promisify(store.getAll() as IDBRequest<CachedTranslation[]>);
    const doomed = rows
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(keep)
      .map((r) => r.key);
    if (!doomed.length) return 0;
    const tx = db.transaction(STORE_TRANSLATIONS, 'readwrite');
    const del = tx.objectStore(STORE_TRANSLATIONS);
    for (const k of doomed) del.delete(k);
    await txDone(tx);
    return doomed.length;
  } catch {
    return 0;
  }
}

// ── housekeeping ─────────────────────────────────────────────────────────────

// Delete cache databases for workspaces the keyring no longer holds — signing
// out of a machine, or closing a share link, shouldn't leave its prose on disk.
// `indexedDB.databases()` is unavailable on older Firefox; there we simply skip
// (the stale DB stays until the browser evicts it, and remains unreadable by any
// other scope).
export async function pruneForeignScopes(liveScopes: string[]): Promise<string[]> {
  if (!idbAvailable() || typeof indexedDB.databases !== 'function') return [];
  const live = new Set(liveScopes.map(dbName));
  let all: Array<{ name?: string }>;
  try {
    all = await indexedDB.databases();
  } catch {
    return [];
  }
  const dropped: string[] = [];
  for (const d of all) {
    if (!d.name || !d.name.startsWith(`${DB_PREFIX}:`) || live.has(d.name)) continue;
    try {
      indexedDB.deleteDatabase(d.name);
      dropped.push(d.name);
    } catch {
      // best effort — a database still open in another tab refuses to delete
    }
  }
  return dropped;
}

// Ask the browser to exempt this origin from best-effort eviction. Chrome grants
// it silently for installed PWAs and engaged sites; Safari ignores it and keeps
// its own 7-day-unused rule. Losing the cache is survivable either way — the
// next sync rebuilds it — so the result is advisory.
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ── measured row heights ────────────────────────────────────────────────────
//
// Keyed by session AND column width, because a height is only true at the width
// it was measured at: the same reply is three lines on a laptop and nine on a
// phone. Widths are rounded into buckets so that a scrollbar appearing, or a
// window dragged a pixel, does not orphan everything measured a moment ago.
//
// One record per (session, width) rather than one per row. A long session has
// thousands of rows, and thousands of IndexedDB keys to write and read back is
// the kind of cost that would outweigh what this saves.

/** Round a column width into the bucket its heights are stored under. */
export function widthBucket(width: number): number {
  return Math.max(0, Math.round(width / HEIGHT_WIDTH_BUCKET) * HEIGHT_WIDTH_BUCKET);
}
const HEIGHT_WIDTH_BUCKET = 8;
/** Sessions × widths kept. Small records, but unbounded growth is still growth. */
const HEIGHTS_LRU = 40;

export type CachedHeights = {
  key: string;
  sessionId: string;
  width: number;
  heights: Record<string, number>;
  lastUsedAt: number;
};

function heightsKey(sessionId: string, width: number): string {
  return `${sessionId}:${widthBucket(width)}`;
}

export async function getHeights(scope: string, sessionId: string, width: number): Promise<Record<string, number>> {
  const db = await openCache(scope);
  if (!db) return {};
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_HEIGHTS, 'readonly');
      const req = tx.objectStore(STORE_HEIGHTS).get(heightsKey(sessionId, width));
      req.onsuccess = () => resolve((req.result as CachedHeights | undefined)?.heights ?? {});
      req.onerror = () => resolve({});
    } catch {
      resolve({});
    }
  });
}

export async function putHeights(
  scope: string,
  sessionId: string,
  width: number,
  heights: Record<string, number>
): Promise<void> {
  const db = await openCache(scope);
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_HEIGHTS, 'readwrite');
      tx.objectStore(STORE_HEIGHTS).put({
        key: heightsKey(sessionId, width),
        sessionId,
        width: widthBucket(width),
        heights,
        lastUsedAt: Date.now(),
      } satisfies CachedHeights);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Oldest-used records first, same shape as the other LRUs here. */
export async function evictHeightsLru(scope: string): Promise<void> {
  const db = await openCache(scope);
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_HEIGHTS, 'readwrite');
      const os = tx.objectStore(STORE_HEIGHTS);
      const countReq = os.count();
      countReq.onsuccess = () => {
        if (countReq.result <= HEIGHTS_LRU) {
          resolve();
          return;
        }
        const all: CachedHeights[] = [];
        const cur = os.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            all.push(c.value as CachedHeights);
            c.continue();
            return;
          }
          all.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
          for (const row of all.slice(0, all.length - HEIGHTS_LRU)) os.delete(row.key);
          resolve();
        };
        cur.onerror = () => resolve();
      };
      countReq.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
