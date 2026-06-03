# Workspace Switcher Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax. This codebase has no unit-test runner; verification is `npm run typecheck` (in `apps/dashboard`) + `next build` + Playwright against the running dashboard. Commit after each task.

**Goal:** Let one browser hold several machines and switch between them via a top-left workspace switcher.

**Architecture:** Client-only browser keyring. `localStorage` holds `KeyringEntry[]` + an active id; the tRPC/SSE/terminal requests send the active machine's key; switching sets the active id and full-reloads. No server/schema changes — the backend already scopes by active key → machine.

**Tech Stack:** Next.js (custom server), React, tRPC (`@trpc/react-query`), `lucide-react`, Tailwind, `createPortal`.

**Spec:** `docs/workspace-switcher-design.md`

---

## File structure

- `apps/dashboard/src/app/providers.tsx` — keyring storage + `getActiveKey()`; tRPC `headers()` reads active key. (Replaces single-key helpers.)
- `apps/dashboard/src/lib/keyring.ts` (new) — pure keyring helpers + types, importable by providers, switcher, auth-gate without circular deps. `machines.me`-by-key fetch helper lives here too.
- `apps/dashboard/src/components/workspace-switcher.tsx` (new) — the top-left switcher (portal dropdown, add/remove/switch, status dots).
- `apps/dashboard/src/components/app-sidebar.tsx` — mount `<WorkspaceSwitcher>` at the top (replace bare logo block); footer sign-out → remove active machine.
- `apps/dashboard/src/components/auth-gate.tsx` — gate on keyring non-empty; pass active machine to sidebar; handle rejected active key.
- `apps/dashboard/src/components/login-screen.tsx` — unchanged surface; submit adds the first keyring entry (handled by auth-gate).

---

## Task 1: Keyring storage module

**Files:**
- Create: `apps/dashboard/src/lib/keyring.ts`
- Modify: `apps/dashboard/src/app/providers.tsx`

- [ ] **Step 1: Create `lib/keyring.ts`**

```ts
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
  try { return JSON.parse(localStorage.getItem(KEYRING) || '[]'); } catch { return []; }
}
function write(list: KeyringEntry[]) {
  localStorage.setItem(KEYRING, JSON.stringify(list));
}

export function getKeyring(): KeyringEntry[] { return read(); }

export function getActiveEntry(): KeyringEntry | null {
  const list = read();
  if (list.length === 0) return null;
  const id = localStorage.getItem(ACTIVE);
  return list.find((e) => e.id === id) ?? list[0];
}

export function getActiveKey(): string { return getActiveEntry()?.key ?? ''; }

export function setActiveMachine(id: string) { localStorage.setItem(ACTIVE, id); }

export function addMachine(entry: KeyringEntry) {
  const list = read().filter((e) => e.id !== entry.id);
  list.push(entry);
  write(list);
  setActiveMachine(entry.id);
}

export function removeMachine(id: string): KeyringEntry | null {
  const list = read();
  const next = list.filter((e) => e.id !== id);
  write(next);
  if (localStorage.getItem(ACTIVE) === id) {
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
  if (!legacy || read().length > 0) { if (legacy) localStorage.removeItem(LEGACY); return; }
  const me = await fetchMachineByKey(legacy).catch(() => null);
  addMachine({ id: me?.id ?? legacy.slice(0, 8), name: me?.name ?? 'machine', key: legacy, hostname: me?.hostname ?? null });
  localStorage.removeItem(LEGACY);
}

export type MachineInfo = { id: string; name: string; hostname?: string | null; lastSeen?: string | null };

// Raw machines.me with an ARBITRARY key (not the shared tRPC client, which only
// carries the active key). Used for add-validation and per-machine status dots.
export async function fetchMachineByKey(key: string): Promise<MachineInfo | null> {
  const url = '/api/trpc/machines.me?batch=1&input=' + encodeURIComponent(JSON.stringify({ '0': { json: null } }));
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
```

- [ ] **Step 2: Point `providers.tsx` at the keyring**

Replace the legacy `getStoredKey/setStoredKey` + `KEY_STORAGE` block (lines ~9-19) with a re-export, and make `headers()` read the active key. Keep the rest of `Providers` intact.

```ts
// near top, after imports:
import { getActiveKey, migrateLegacyKey } from '@/lib/keyring';
export { getActiveKey } from '@/lib/keyring';

// inside httpBatchLink config:
headers() { return { 'x-asst-key': getActiveKey() }; }

// run migration once on mount (add to the existing useEffect block or a new one):
useEffect(() => { void migrateLegacyKey(); }, []);
```

Remove `getStoredKey`/`setStoredKey`/`KEY_STORAGE` (callers switch to keyring helpers in later tasks).

- [ ] **Step 3: Typecheck**

Run: `cd apps/dashboard && npm run typecheck`
Expected: errors only in files that still import `getStoredKey/setStoredKey` (auth-gate) — fixed in Task 3. No errors in `keyring.ts`/`providers.tsx`.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/lib/keyring.ts apps/dashboard/src/app/providers.tsx
git commit -m "feat(dashboard): browser keyring storage + active-key header"
```

---

## Task 2: WorkspaceSwitcher component

**Files:**
- Create: `apps/dashboard/src/components/workspace-switcher.tsx`

- [ ] **Step 1: Build the component**

Portal dropdown anchored to a trigger button. Trigger shows the active machine (avatar initials + name + chevron); collapsed shows avatar only. Dropdown lists keyring machines (status dot from `fetchMachineByKey` on open, check on active, remove control) + an "Add machine" inline key input. Switching/adding calls `setActiveMachine`/`addMachine` then `window.location.href = '/chat'`.

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown, Plus, Trash2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getKeyring, getActiveEntry, setActiveMachine, addMachine, removeMachine, fetchMachineByKey, isOnline, type KeyringEntry } from '@/lib/keyring';

const initials = (s: string) => (s || '?').slice(0, 2).toUpperCase();
const go = () => { window.location.href = '/chat'; };

export function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<KeyringEntry[]>([]);
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const active = getActiveEntry();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  useEffect(() => { setList(getKeyring()); }, []);
  // Ping each key for online dots when the menu opens.
  useEffect(() => {
    if (!open) return;
    setList(getKeyring());
    let cancelled = false;
    Promise.all(getKeyring().map(async (e) => [e.id, isOnline((await fetchMachineByKey(e.key))?.lastSeen)] as const))
      .then((rows) => { if (!cancelled) setStatus(Object.fromEntries(rows)); });
    return () => { cancelled = true; };
  }, [open]);
  // Anchor the portal to the trigger; close on Esc / outside click.
  useEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 6, width: Math.max(r.width, 240) });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => { if (!btnRef.current?.parentElement?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick); };
  }, [open]);

  const pick = (id: string) => { if (id !== active?.id) { setActiveMachine(id); go(); } else setOpen(false); };
  const drop = (id: string) => { const next = removeMachine(id); setList(getKeyring()); if (id === active?.id) { if (next) go(); else window.location.href = '/'; } };

  return (
    <div className="relative">
      <button ref={btnRef} type="button" onClick={() => setOpen((v) => !v)}
        className={cn('flex items-center gap-2 rounded-lg h-10 w-full px-2 hover:bg-sidebar-accent transition-colors cursor-pointer', collapsed && 'lg:justify-center lg:px-0')}>
        <span className="h-7 w-7 shrink-0 rounded-md bg-sidebar-accent text-sidebar-foreground flex items-center justify-center text-[11px] font-medium" aria-hidden>{initials(active?.name ?? '?')}</span>
        <span className={cn('flex-1 min-w-0 text-left', collapsed && 'lg:hidden')}>
          <span className="block text-sm font-medium truncate">{active?.name ?? 'machine'}</span>
          {active?.hostname && <span className="block text-[10px] text-muted-foreground truncate font-mono">{active.hostname}</span>}
        </span>
        <ChevronsUpDown className={cn('h-4 w-4 text-muted-foreground shrink-0', collapsed && 'lg:hidden')} />
      </button>
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div className="fixed z-[60] rounded-lg border border-sidebar-border bg-sidebar shadow-lg p-1" style={{ left: pos.left, top: pos.top, width: pos.width }}>
          {list.map((e) => (
            <div key={e.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent">
              <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', status[e.id] ? 'bg-emerald-500' : 'border border-muted-foreground/40')} />
              <button type="button" onClick={() => pick(e.id)} className="flex-1 min-w-0 text-left cursor-pointer">
                <span className="block text-[13px] truncate">{e.name}</span>
                {e.hostname && <span className="block text-[10px] text-muted-foreground truncate font-mono">{e.hostname}</span>}
              </button>
              {e.id === active?.id ? <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                : <button type="button" onClick={() => drop(e.id)} aria-label="remove" className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-rose-400 cursor-pointer"><Trash2 className="h-3.5 w-3.5" /></button>}
            </div>
          ))}
          <div className="my-1 h-px bg-sidebar-border" />
          <AddMachine onAdded={go} />
        </div>, document.body)}
    </div>
  );
}

function AddMachine({ onAdded }: { onAdded: () => void }) {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!key) return; setBusy(true); setErr('');
    const m = await fetchMachineByKey(key).catch(() => null);
    setBusy(false);
    if (!m) { setErr('invalid key'); return; }
    addMachine({ id: m.id, name: m.name, key, hostname: m.hostname }); onAdded();
  };
  if (!adding) return (
    <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground cursor-pointer">
      <Plus className="h-3.5 w-3.5" /> Add machine
    </button>);
  return (
    <form onSubmit={submit} className="p-1 space-y-1">
      <input autoFocus type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="X-Asst-Key" className="w-full rounded-md bg-background border border-sidebar-border px-2 py-1 text-xs font-mono outline-none focus:border-sidebar-foreground/40" />
      {err && <p className="text-[10px] text-rose-400 px-1">{err}</p>}
      <button type="submit" disabled={busy || !key} className="flex items-center justify-center gap-1 w-full rounded-md bg-sidebar-accent px-2 py-1 text-xs disabled:opacity-50 cursor-pointer">
        {busy && <Loader2 className="h-3 w-3 animate-spin" />} Add
      </button>
    </form>);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && npm run typecheck`
Expected: no errors in `workspace-switcher.tsx`.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/workspace-switcher.tsx
git commit -m "feat(dashboard): WorkspaceSwitcher component (portal dropdown, add/remove/switch)"
```

---

## Task 3: Wire switcher into sidebar + auth-gate + login

**Files:**
- Modify: `apps/dashboard/src/components/app-sidebar.tsx` (header block ~222-236; footer ~287-307)
- Modify: `apps/dashboard/src/components/auth-gate.tsx`
- Modify: `apps/dashboard/src/components/login-screen.tsx` (no change to surface; add via auth-gate)

- [ ] **Step 1: Mount switcher at sidebar top**

In `app-sidebar.tsx`, import `WorkspaceSwitcher`, and replace the header `<div className="flex items-center h-12 …">` logo+collapse block so the collapse toggle stays but the logo `<Link>` is replaced by `<WorkspaceSwitcher collapsed={collapsed} />`:

```tsx
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
// header block:
<div className={cn('flex items-center gap-1 h-12 px-2 shrink-0')}>
  <div className="flex-1 min-w-0"><WorkspaceSwitcher collapsed={collapsed} /></div>
  <button type="button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'expand sidebar' : 'collapse sidebar'}
    className="hidden lg:inline-flex p-1.5 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors cursor-pointer shrink-0">
    <PanelLeft className="h-4 w-4" />
  </button>
</div>
```

Footer (~287-307): keep machine name display, change the sign-out button's `onClick` to remove the active machine. Simplest: leave `onLogout` prop but have auth-gate pass a handler that removes-active. (Done in Step 2.)

- [ ] **Step 2: auth-gate keyring gate + sign-out semantics**

Rewrite `auth-gate.tsx` to gate on keyring non-empty and define sign-out as "remove active machine":

```tsx
'use client';
import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { getKeyring, addMachine, removeMachine, getActiveEntry, fetchMachineByKey } from '@/lib/keyring';
import { LoginScreen } from '@/components/login-screen';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AppSidebar, SidebarProvider } from '@/components/app-sidebar';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setCount(getKeyring().length); setHydrated(true); }, []);
  if (!hydrated) return null;
  if (count === 0) return (
    <LoginScreen onSubmit={async (k) => {
      const m = await fetchMachineByKey(k).catch(() => null);
      if (!m) return 'invalid key';
      addMachine({ id: m.id, name: m.name, key: k, hostname: m.hostname });
      window.location.href = '/chat'; return null;
    }} />);
  return <Authed onSignOut={() => { const a = getActiveEntry(); const next = a ? removeMachine(a.id) : null; window.location.href = next ? '/chat' : '/'; }}>{children}</Authed>;
}

function Authed({ onSignOut, children }: { onSignOut: () => void; children: React.ReactNode }) {
  const me = trpc.machines.me.useQuery(undefined, { retry: false, refetchInterval: 30_000 });
  if (me.error?.data?.code === 'UNAUTHORIZED') return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="max-w-md p-6 space-y-3 border-rose-500/40">
        <p className="text-rose-400 font-medium">invalid key</p>
        <p className="text-sm text-muted-foreground">The active machine's key was rejected.</p>
        <Button variant="secondary" onClick={onSignOut}>remove this machine</Button>
      </Card>
    </main>);
  return (
    <SidebarProvider>
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <AppSidebar machine={me.data} onLogout={onSignOut} />
        <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">{children}</main>
      </div>
    </SidebarProvider>);
}
```

- [ ] **Step 3: login-screen returns an error string**

Change `LoginScreen` `onSubmit` to `(k: string) => Promise<string | null>`; show the returned error inline; keep the password input + seed hint.

```tsx
export function LoginScreen({ onSubmit }: { onSubmit: (k: string) => Promise<string | null> }) {
  const [key, setKey] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  // form onSubmit: setBusy(true); const e = await onSubmit(key); setBusy(false); if (e) setErr(e);
  // render {err && <p className="text-xs text-rose-400">{err}</p>}, disable button while busy.
}
```

- [ ] **Step 4: Typecheck + build**

Run: `cd apps/dashboard && npm run typecheck && npm run build`
Expected: clean. Fix any leftover `getStoredKey` references.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/app-sidebar.tsx apps/dashboard/src/components/auth-gate.tsx apps/dashboard/src/components/login-screen.tsx
git commit -m "feat(dashboard): mount switcher in sidebar; keyring-based auth-gate + login"
```

---

## Task 4: Deploy + verify on the live dashboard

- [ ] **Step 1: Push branch + deploy to VPS**

`vps-deploy.sh` pulls `main`, so deploy the branch manually — build before restart; gitignored `.env`/`node_modules`/`.next`/`src/generated` survive the checkout:

```bash
git push -u origin feature/workspace-switcher
ssh <vps> 'cd ~/hermit-ui && git fetch origin \
  && git checkout feature/workspace-switcher && git reset --hard origin/feature/workspace-switcher \
  && cd apps/dashboard && node ../../node_modules/next/dist/bin/next build \
  && pm2 restart hermit-ui-dashboard --update-env'
```
Expected: build succeeds, pm2 restart, dashboard returns 200. `main` untouched until merge.

- [ ] **Step 2: Playwright smoke test**

Drive `https://dash.swaylab.ai` with the playwright-browser MCP:
1. Confirm existing session still works (legacy key migrated → switcher shows machine1).
2. Open switcher → "Add machine" → paste the second machine's key → switcher now lists both, dots show online.
3. Switch to the second machine → page reloads → Agents list shows its agent, not machine 1's.
4. Switch back → machine1's agents return. Remove machine2 → it disappears.

Expected: each step passes; no console errors.

- [ ] **Step 3: Verdict**

If all pass, report to user with screenshots and offer to merge to `main` + deploy. If issues, fix inline and re-verify.

---

## Notes

- No schema/gateway/router changes — `main` deploy risk is frontend-only.
- The switcher's "Add machine" needs the target machine's key (from `npm run seed`); surfacing the seed/gateway-install hint in the add UI is a possible follow-up, not in this plan.
