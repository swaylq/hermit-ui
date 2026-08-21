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

import type { CachedText, CachedSession, CachedFullRow, FullMeta } from './types';

const DB_PREFIX = 'hermit-chat-cache';
// 2: `text` rows gained `blocks`, so interaction cards survive in cache-served
// history. The projection changed, not the schema — but a delta sync only
// refetches what MOVED, so old rows would keep their old shape forever. Wiping
// the bookkeeping on upgrade makes the next pass a full refetch (~11 MB,
// background, behind the usual "正在建立本地索引…" line).
// 3: added the `digest` store — history pages as the collapsed timeline renders
// them. Purely additive; nothing already cached changes meaning.
const DB_VERSION = 3;

export const STORE_TEXT = 'text';
export const STORE_SESSIONS = 'sessions';
export const STORE_FULL = 'full';
export const STORE_FULL_META = 'fullMeta';
// History pages in their DIGESTED form: tool arguments trimmed to the preview
// the collapsed capsule shows, results to their first line, thinking to its
// length (server/message-digest.ts). Roughly 5% of what `full` costs per row,
// which is what lets a second walk back through a long session be free.
export const STORE_DIGEST = 'digest';

// How many sessions keep their full (renderable) rows. The prose layer covers
// every session; this one only makes RE-opening a session instant, so a handful
// of recents is the whole benefit. 15 sessions of median size (~390 messages)
// is a few MB.
export const FULL_LRU_SESSIONS = 15;

export function scopeId(machineId: string, agentName?: string | null): string {
  return agentName ? `${machineId}::${agentName}` : machineId;
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

const ALL_STORES = [STORE_TEXT, STORE_SESSIONS, STORE_FULL, STORE_FULL_META, STORE_DIGEST];

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
