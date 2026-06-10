'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown, Plus, Trash2, Loader2, Pencil, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getKeyring,
  getActiveEntry,
  setActiveMachine,
  addMachine,
  removeMachine,
  fetchMachineByKey,
  setMachineAlias,
  renameEntry,
  displayName,
  isOnline,
  type KeyringEntry,
} from '@/lib/keyring';

const initials = (s: string) => (s || '?').slice(0, 2).toUpperCase();
// Switching machines is a hard reload: rebuilds the tRPC client with the new
// active key and resets the React Query cache + SSE/terminal sockets cleanly.
const go = () => {
  window.location.href = '/chat';
};

export function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<KeyringEntry[]>([]);
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const active = getActiveEntry();
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    setList(getKeyring());
  }, []);

  // Ping each key for online dots when the menu opens.
  useEffect(() => {
    if (!open) return;
    setList(getKeyring());
    let cancelled = false;
    Promise.all(
      getKeyring().map(
        async (e) => [e.id, isOnline((await fetchMachineByKey(e.key))?.lastSeen)] as const,
      ),
    ).then((rows) => {
      if (!cancelled) setStatus(Object.fromEntries(rows));
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Anchor the portal to the trigger; close on Esc / outside click (but NOT when
  // clicking inside the portaled menu itself).
  useEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 6, width: Math.max(r.width, 240) });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const pick = (id: string) => {
    if (id !== active?.id) {
      setActiveMachine(id);
      go();
    } else {
      setOpen(false);
    }
  };
  const drop = (id: string) => {
    const next = removeMachine(id);
    setList(getKeyring());
    if (id === active?.id) {
      if (next) go();
      else window.location.href = '/';
    }
  };
  // Save a machine's server-side alias (blank clears it). Updates the cached
  // keyring entry; setList re-renders so the button + row pick up the new label
  // (active is recomputed from the keyring on render — no reload needed).
  const saveAlias = async (e: KeyringEntry) => {
    setSavingId(e.id);
    try {
      const saved = await setMachineAlias(e.key, draft.trim() || null);
      renameEntry(e.id, saved);
      setList(getKeyring());
      setEditingId(null);
    } catch {
      /* keep the input open on failure */
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="switch workspace"
        className={cn(
          'flex items-center gap-2 rounded-lg h-10 w-full px-2 hover:bg-sidebar-accent transition-colors cursor-pointer',
          collapsed && 'lg:justify-center lg:px-0',
        )}
      >
        <span
          className="h-7 w-7 shrink-0 rounded-md bg-sidebar-accent text-sidebar-foreground flex items-center justify-center text-[11px] font-medium"
          aria-hidden
        >
          {initials(active ? displayName(active) : '?')}
        </span>
        <span className={cn('flex-1 min-w-0 text-left', collapsed && 'lg:hidden')}>
          <span className="block text-sm font-medium truncate">{active ? displayName(active) : 'machine'}</span>
          {active?.hostname && (
            <span className="block text-[10px] text-muted-foreground truncate font-mono">{active.hostname}</span>
          )}
        </span>
        <ChevronsUpDown className={cn('h-4 w-4 text-muted-foreground shrink-0', collapsed && 'lg:hidden')} />
      </button>

      {open &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[60] rounded-lg border border-sidebar-border bg-sidebar shadow-lg p-1"
            style={{ left: pos.left, top: pos.top, width: pos.width }}
          >
            {list.map((e) =>
              editingId === e.id ? (
                <form
                  key={e.id}
                  onSubmit={(ev) => { ev.preventDefault(); saveAlias(e); }}
                  className="flex items-center gap-1 rounded-md px-2 py-1.5"
                >
                  <span className="h-1.5 w-1.5 rounded-full shrink-0 border border-muted-foreground/40" aria-hidden />
                  <input
                    autoFocus
                    value={draft}
                    onChange={(ev) => setDraft(ev.target.value)}
                    placeholder={e.name}
                    maxLength={40}
                    className="flex-1 min-w-0 rounded bg-background border border-sidebar-border px-1.5 py-0.5 text-[13px] outline-none focus:border-sidebar-foreground/40"
                  />
                  <button type="submit" disabled={savingId === e.id} aria-label="save alias" className="text-emerald-500 hover:text-emerald-400 cursor-pointer shrink-0 disabled:opacity-50">
                    {savingId === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </button>
                  <button type="button" onClick={() => setEditingId(null)} aria-label="cancel" className="text-muted-foreground hover:text-sidebar-foreground cursor-pointer shrink-0">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </form>
              ) : (
                <div
                  key={e.id}
                  className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent"
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full shrink-0',
                      status[e.id] ? 'bg-emerald-500' : 'border border-muted-foreground/40',
                    )}
                    aria-hidden
                  />
                  <button
                    type="button"
                    onClick={() => pick(e.id)}
                    className="flex-1 min-w-0 text-left cursor-pointer"
                  >
                    <span className="block text-[13px] truncate text-sidebar-foreground">{displayName(e)}</span>
                    {e.hostname && (
                      <span className="block text-[10px] text-muted-foreground truncate font-mono">{e.hostname}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setEditingId(e.id); setDraft(e.alias ?? ''); }}
                    aria-label={`rename ${displayName(e)}`}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-sidebar-foreground cursor-pointer shrink-0"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {e.id === active?.id ? (
                    <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  ) : (
                    <button
                      type="button"
                      onClick={() => drop(e.id)}
                      aria-label={`remove ${displayName(e)}`}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-rose-400 cursor-pointer shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ),
            )}
            <div className="my-1 h-px bg-sidebar-border" />
            <AddMachine onAdded={go} />
          </div>,
          document.body,
        )}
    </div>
  );
}

function AddMachine({ onAdded }: { onAdded: () => void }) {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key) return;
    setBusy(true);
    setErr('');
    const m = await fetchMachineByKey(key).catch(() => null);
    setBusy(false);
    if (!m) {
      setErr('invalid key');
      return;
    }
    addMachine({ id: m.id, name: m.name, key, hostname: m.hostname, alias: m.alias });
    onAdded();
  };

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground cursor-pointer"
      >
        <Plus className="h-3.5 w-3.5" /> Add machine
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="p-1 space-y-1">
      <input
        autoFocus
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="X-Asst-Key"
        className="w-full rounded-md bg-background border border-sidebar-border px-2 py-1 text-xs font-mono outline-none focus:border-sidebar-foreground/40"
      />
      {err && <p className="text-[10px] text-rose-400 px-1">{err}</p>}
      <button
        type="submit"
        disabled={busy || !key}
        className="flex items-center justify-center gap-1 w-full rounded-md bg-sidebar-accent px-2 py-1 text-xs disabled:opacity-50 cursor-pointer"
      >
        {busy && <Loader2 className="h-3 w-3 animate-spin" />} Add
      </button>
    </form>
  );
}
