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
export type KeyringEntry = { id: string; name: string; key: string; hostname?: string | null; alias?: string | null; scoped?: boolean; agentName?: string | null };

const KEYRING = 'asst-dashboard-keyring';
const ACTIVE = 'asst-dashboard-active';
const LEGACY = 'asst-dashboard-key'; // pre-keyring single key

function read(): KeyringEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const v = JSON.parse(localStorage.getItem(KEYRING) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function write(list: KeyringEntry[]) {
  localStorage.setItem(KEYRING, JSON.stringify(list));
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
// carries the active key). Used for add-validation and per-machine status dots.
export async function fetchMachineByKey(key: string): Promise<MachineInfo | null> {
  if (!key) return null;
  const url =
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
export async function setMachineAlias(key: string, alias: string | null): Promise<string | null> {
  const r = await fetch('/api/trpc/machines.setAlias?batch=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': key },
    body: JSON.stringify({ '0': { json: { alias } } }),
  });
  if (!r.ok) throw new Error(`setAlias → ${r.status}`);
  const j = await r.json();
  return j?.[0]?.result?.data?.json?.alias ?? null;
}
