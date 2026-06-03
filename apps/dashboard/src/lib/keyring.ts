'use client';

// Browser keyring: the dashboard can hold several machines, each with its own
// X-Asst-Key. The ACTIVE entry's key is sent on every request; the backend
// scopes all data by that key → machine. Switching = set active + full reload.

export type KeyringEntry = { id: string; name: string; key: string; hostname?: string | null };

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

export function getActiveEntry(): KeyringEntry | null {
  const list = read();
  if (list.length === 0) return null;
  const id = typeof window === 'undefined' ? null : localStorage.getItem(ACTIVE);
  return list.find((e) => e.id === id) ?? list[0];
}

export function getActiveKey(): string {
  return getActiveEntry()?.key ?? '';
}

export function setActiveMachine(id: string) {
  localStorage.setItem(ACTIVE, id);
}

export function addMachine(entry: KeyringEntry) {
  const list = read().filter((e) => e.id !== entry.id);
  list.push(entry);
  write(list);
  setActiveMachine(entry.id);
}

// Returns the next active entry (first remaining), or null if the keyring is empty.
export function removeMachine(id: string): KeyringEntry | null {
  const next = read().filter((e) => e.id !== id);
  write(next);
  if (typeof window !== 'undefined' && localStorage.getItem(ACTIVE) === id) {
    if (next[0]) setActiveMachine(next[0].id);
    else localStorage.removeItem(ACTIVE);
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
  });
  localStorage.removeItem(LEGACY);
}

export type MachineInfo = { id: string; name: string; hostname?: string | null; lastSeen?: string | null };

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
  return m ? { id: m.id, name: m.name, hostname: m.hostname, lastSeen: m.lastSeen } : null;
}

export function isOnline(lastSeen?: string | null): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 90_000;
}
