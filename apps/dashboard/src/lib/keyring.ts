'use client';

// Browser keyring: the dashboard can hold several machines, each with its own
// X-Asst-Key. The ACTIVE entry's key is sent on every request; the backend
// scopes all data by that key → machine. Switching = set active + full reload.
//
// The keyring LIST lives in localStorage (shared across tabs — you don't re-add
// machines per tab). The ACTIVE selection lives in sessionStorage, so it's
// PER-TAB: two tabs can view different machines, and each tab keeps its pick
// across a refresh. The localStorage copy is only the "default" a freshly-opened
// tab inherits (the last machine picked in any tab) — see activeId().

// `scoped`/`agentName` mark an AGENT SHARE entry: its `key` is a `shr_…` token
// that grants access to only that one agent (vs a machine key). The UI reads
// these to render the stripped scoped shell; the server is the real boundary.
// `baseUrl` is the ORIGIN of the dashboard deployment this entry lives on
// (`https://hermit.zhinan.tech`). Empty/absent = this origin, which is what
// every entry meant before multi-deployment support, so old keyrings keep
// working untouched. See lib/api-base.ts for how it is applied.
export type KeyringEntry = { id: string; name: string; key: string; hostname?: string | null; alias?: string | null; scoped?: boolean; agentName?: string | null; baseUrl?: string | null };

const KEYRING = 'asst-dashboard-keyring';
const ACTIVE = 'asst-dashboard-active';
const LEGACY = 'asst-dashboard-key'; // pre-keyring single key

// Where the list actually lives. In a browser that is localStorage, as it always
// was. Inside the iOS shell it is the device Keychain, reached over the native
// bridge (`keychain.get` / `.set` / `.clear`) — machine keys are bearer tokens for
// a whole machine, and localStorage is an unencrypted SQLite file in the app
// container. See apps/ios/Hermit/Keychain.swift.
//
// The Keychain is asynchronous and `getActiveKey()` is called on every request,
// so the list is held in memory for the life of the document and the Keychain is
// written behind it. `hydrateKeyring()` fills that in before anything renders
// (components/auth-gate.tsx); until it has run, or in any browser, `secure` stays
// null and every path below is the localStorage one it has always been.
let secure: KeyringEntry[] | null = null;

function parseList(raw: string | null): KeyringEntry[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function readLocal(): KeyringEntry[] {
  if (typeof window === 'undefined') return [];
  return parseList(localStorage.getItem(KEYRING));
}

function read(): KeyringEntry[] {
  return secure ?? readLocal();
}
function write(list: KeyringEntry[]) {
  if (secure !== null) {
    secure = list;
    pushToShell(list);
    return;
  }
  localStorage.setItem(KEYRING, JSON.stringify(list));
}

// Imported at call time, not at the top of the file: native-bridge.ts imports
// THIS module, and a static cycle would have one of the two evaluate half-empty.
// Kept once it has loaded, which is what lets a write post its message with no
// awaits in front of it — see pushToShell.
type Bridge = typeof import('./native-bridge');
let bridge: Bridge | null = null;
async function askShell<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  bridge ??= await import('./native-bridge');
  return bridge.nativeRequest<T>(method, params);
}

// One write at a time. Two overlapping `keychain.set`s could land in the other
// order and leave the Keychain holding the older list — and the in-memory copy,
// which is what the app reads, would then disagree with it until the next launch.
let pushQueue: Promise<unknown> = Promise.resolve();
function pushToShell(list: KeyringEntry[]) {
  // Signing out of the last machine clears the entry rather than storing an
  // empty list: nothing left to keep is not the same as "keep nothing".
  const send = (b: Bridge) =>
    list.length === 0
      ? b.nativeRequest('keychain.clear')
      : b.nativeRequest('keychain.set', { value: JSON.stringify(list) });
  // The module is already loaded here in practice — hydrateKeyring warms it at
  // boot — and that matters: signing in writes the keyring and then immediately
  // sets `location.href`. A queued microtask still runs before the document goes
  // away, so the message reaches the shell; waiting on a chunk fetch would not,
  // and the key would be gone by the next launch.
  pushQueue = pushQueue
    .then(() => (bridge ? send(bridge) : import('./native-bridge').then((b) => send((bridge = b)))))
    .catch((e: unknown) => {
      console.warn('[keyring] the shell would not store the keyring:', e);
    });
}

/**
 * Tell the shell which entry this tab is using.
 *
 * The LIST is in the device Keychain; the SELECTION is `sessionStorage`, which
 * is inside the web view and invisible to native code. A native screen that
 * makes its own request therefore had no way to pick the same key the page
 * picks, and `list[0]` is only right until the user switches machines — after
 * that the native session list would quietly show a different machine than the
 * page above it, with nothing anywhere saying so.
 *
 * So the selection is mirrored across whenever it changes. Same queue as the
 * list write, so the two cannot land out of order; a browser, or a shell too old
 * for the method, is a no-op.
 */
function pushActiveToShell(id: string) {
  if (secure === null) return;
  pushQueue = pushQueue
    .then(() => askShell('keychain.setActive', { id }))
    .catch((e: unknown) => {
      console.warn('[keyring] the shell would not record the active machine:', e);
    });
}

/**
 * Move the keyring into the device Keychain, once, before the app reads it.
 *
 * A no-op everywhere except the iOS shell — in a browser, and in any shell too
 * old to know the method, `nativeRequest` rejects and the keyring stays exactly
 * where it was. Awaited by the auth gate, which renders nothing until it returns.
 *
 * The migration order is write → read back → only then drop the localStorage
 * copy. Clearing first, or clearing on the strength of a write that merely didn't
 * throw, would sign the user out of every machine they have if the Keychain
 * refused the item.
 */
export async function hydrateKeyring(): Promise<void> {
  if (typeof window === 'undefined' || secure !== null) return;
  let stored: string | null;
  try {
    const got = await askShell<{ value?: unknown }>('keychain.get');
    stored = typeof got?.value === 'string' ? got.value : null;
  } catch {
    return;
  }
  if (stored !== null) {
    secure = parseList(stored);
    // The Keychain is the store now, so a plaintext copy sitting beside it is
    // the exact thing this change exists to remove.
    localStorage.removeItem(KEYRING);
    return;
  }
  const local = readLocal();
  if (local.length === 0) {
    secure = [];
    return;
  }
  const payload = JSON.stringify(local);
  try {
    await askShell('keychain.set', { value: payload });
    const back = await askShell<{ value?: unknown }>('keychain.get');
    if (back?.value !== payload) return; // not verified → leave localStorage alone, retry next launch
  } catch {
    return;
  }
  secure = local;
  localStorage.removeItem(KEYRING);
  // Whatever this tab is about to use — including the `list[0]` fallback when
  // nothing has ever been picked. Without this, an install that was already
  // signed in would carry no active id at all until the next machine switch,
  // and every native screen would run on the fallback in the meantime.
  pushActiveToShell(getActiveEntry()?.id ?? '');
}

export function getKeyring(): KeyringEntry[] {
  return read();
}

// This tab's active machine id. sessionStorage wins (per-tab, survives refresh);
// a fresh tab snapshots the localStorage default into its own sessionStorage on
// first read, so a later switch in ANOTHER tab can't change what THIS tab shows
// after its next refresh.
function activeId(): string | null {
  if (typeof window === 'undefined') return null;
  let id = sessionStorage.getItem(ACTIVE);
  if (id == null) {
    id = localStorage.getItem(ACTIVE);
    if (id != null) sessionStorage.setItem(ACTIVE, id);
  }
  return id;
}

export function getActiveEntry(): KeyringEntry | null {
  const list = read();
  if (list.length === 0) return null;
  return list.find((e) => e.id === activeId()) ?? list[0];
}

export function getActiveKey(): string {
  return getActiveEntry()?.key ?? '';
}

export function setActiveMachine(id: string) {
  if (typeof window === 'undefined') return;
  // This tab's pick → sessionStorage (per-tab, survives refresh). Mirror it to
  // localStorage so the NEXT freshly-opened tab inherits your latest machine.
  sessionStorage.setItem(ACTIVE, id);
  localStorage.setItem(ACTIVE, id);
  pushActiveToShell(id);
}

export function addMachine(entry: KeyringEntry) {
  const list = read().filter((e) => e.id !== entry.id);
  list.push(entry);
  write(list);
  setActiveMachine(entry.id);
}

// Add an agent SHARE entry and make it active FOR THIS TAB only. Unlike
// addMachine it does NOT clobber the localStorage default when the user already
// has one — so opening a share link in a tab can't hijack an owner's other tabs
// or what a freshly-opened tab inherits. A first-time visitor (no default yet)
// does get it as their default.
export function addScopedMachine(entry: KeyringEntry) {
  const list = read().filter((e) => e.id !== entry.id);
  list.push(entry);
  write(list);
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(ACTIVE, entry.id);
  if (localStorage.getItem(ACTIVE) == null) localStorage.setItem(ACTIVE, entry.id);
  pushActiveToShell(entry.id);
}

// Returns the next active entry (first remaining), or null if the keyring is empty.
export function removeMachine(id: string): KeyringEntry | null {
  const next = read().filter((e) => e.id !== id);
  write(next);
  if (typeof window !== 'undefined' && activeId() === id) {
    if (next[0]) setActiveMachine(next[0].id);
    else {
      sessionStorage.removeItem(ACTIVE);
      localStorage.removeItem(ACTIVE);
      // `write([])` above already sent `keychain.clear`, which drops the active
      // id with the list. This is the case where entries remain but none is
      // active — impossible today (next[0] exists whenever the list is
      // non-empty) and harmless if it ever is.
      pushActiveToShell('');
    }
  }
  return next[0] ?? null;
}

// Migrate the legacy single key into the keyring on first load. Resolves
// name/hostname via machines.me; falls back to a placeholder name if offline.
export async function migrateLegacyKey(): Promise<void> {
  if (typeof window === 'undefined') return;
  const legacy = localStorage.getItem(LEGACY);
  if (!legacy) return;
  if (read().length > 0) {
    localStorage.removeItem(LEGACY);
    return;
  }
  const me = await fetchMachineByKey(legacy).catch(() => null);
  addMachine({
    id: me?.id ?? legacy.slice(0, 8),
    name: me?.name ?? 'machine',
    key: legacy,
    hostname: me?.hostname ?? null,
    alias: me?.alias ?? null,
  });
  localStorage.removeItem(LEGACY);
}

export type MachineInfo = { id: string; name: string; alias?: string | null; hostname?: string | null; lastSeen?: string | null };

// Raw machines.me with an ARBITRARY key (not the shared tRPC client, which only
// carries the active key AND is pinned to the active backend). Used for
// add-validation and per-machine status dots — both of which must be able to
// reach an entry that is NOT the active one, possibly on another deployment,
// hence the explicit `base`.
export async function fetchMachineByKey(key: string, base = ''): Promise<MachineInfo | null> {
  if (!key) return null;
  const url =
    (base || '') +
    '/api/trpc/machines.me?batch=1&input=' +
    encodeURIComponent(JSON.stringify({ '0': { json: null } }));
  const r = await fetch(url, { headers: { 'x-asst-key': key } });
  if (!r.ok) return null;
  const j = await r.json();
  const m = j?.[0]?.result?.data?.json;
  return m ? { id: m.id, name: m.name, alias: m.alias, hostname: m.hostname, lastSeen: m.lastSeen } : null;
}

export function isOnline(lastSeen?: string | null): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 90_000;
}

// Display label for a machine: the user-set alias, else the machine name.
export function displayName(e: { alias?: string | null; name: string }): string {
  return (e.alias && e.alias.trim()) || e.name;
}

// Update an entry's cached alias in the keyring (after the server save succeeds).
export function renameEntry(id: string, alias: string | null) {
  write(read().map((e) => (e.id === id ? { ...e, alias } : e)));
}

// Set a machine's server-side alias using an ARBITRARY key, so the switcher can
// rename any machine (not just the active one). Returns the saved alias.
export async function setMachineAlias(key: string, alias: string | null, base = ''): Promise<string | null> {
  const r = await fetch((base || '') + '/api/trpc/machines.setAlias?batch=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': key },
    body: JSON.stringify({ '0': { json: { alias } } }),
  });
  if (!r.ok) throw new Error(`setAlias → ${r.status}`);
  const j = await r.json();
  return j?.[0]?.result?.data?.json?.alias ?? null;
}
