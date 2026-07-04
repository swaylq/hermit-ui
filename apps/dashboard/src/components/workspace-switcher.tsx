'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown, Trash2, Loader2, Pencil, X } from 'lucide-react';
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
import { AddMachine } from './add-machine';

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
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  // Removing a machine is a two-tap confirm (id armed for deletion) so a stray
  // tap on phones — where the action icons can't hide behind hover — can't wipe a
  // workspace by accident.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // Reset any armed delete / open rename when the menu closes.
  useEffect(() => {
    if (!open) { setConfirmingId(null); setEditingId(null); }
  }, [open]);

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
    if (r) {
      const width = Math.max(r.width, 240);
      // The switcher now lives in the sidebar FOOTER, so the trigger sits near the
      // bottom of the viewport — open the menu upward when there isn't room below
      // (anchor its bottom to the trigger's top instead of top→bottom).
      const spaceBelow = window.innerHeight - r.bottom;
      setPos(
        spaceBelow < 340
          ? { left: r.left, bottom: window.innerHeight - r.top + 6, width }
          : { left: r.left, top: r.bottom + 6, width },
      );
    }
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
            className={cn(
              'fixed z-[60] max-h-[70vh] overflow-y-auto rounded-lg border border-sidebar-border bg-sidebar shadow-lg p-1',
              // subtle open transition, matching the base-ui Select popup; anchor the
              // zoom to whichever edge the menu drops from (down → top, up → bottom).
              'animate-in fade-in-0 zoom-in-95 duration-150',
              pos.bottom != null ? 'origin-bottom' : 'origin-top',
            )}
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }}
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
                  <button type="submit" disabled={savingId === e.id} aria-label="save alias" className="shrink-0 rounded p-1.5 text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10 cursor-pointer disabled:opacity-50">
                    {savingId === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </button>
                  <button type="button" onClick={() => setEditingId(null)} aria-label="cancel rename" className="shrink-0 rounded p-1.5 text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent cursor-pointer">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </form>
              ) : confirmingId === e.id ? (
                // Armed for removal: explicit confirm so a mis-tap can't wipe a workspace.
                <div
                  key={e.id}
                  className="flex items-center gap-1 rounded-md px-2 py-1.5 bg-rose-500/5"
                >
                  <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-rose-400/70" aria-hidden />
                  <span className="flex-1 min-w-0 text-[13px] text-rose-500 truncate">Remove {displayName(e)}?</span>
                  <button
                    type="button"
                    onClick={() => { setConfirmingId(null); drop(e.id); }}
                    aria-label={`confirm remove ${displayName(e)}`}
                    className="shrink-0 rounded p-1.5 text-rose-500 hover:bg-rose-500/10 cursor-pointer"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingId(null)}
                    aria-label="cancel remove"
                    className="shrink-0 rounded p-1.5 text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div
                  key={e.id}
                  className="group flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-sidebar-accent"
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
                    className="flex-1 min-w-0 text-left cursor-pointer py-0.5 pr-1"
                  >
                    <span className="block text-[13px] truncate text-sidebar-foreground">{displayName(e)}</span>
                    {e.hostname && (
                      <span className="block text-[10px] text-muted-foreground truncate font-mono">{e.hostname}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setConfirmingId(null); setEditingId(e.id); setDraft(e.alias ?? ''); }}
                    aria-label={`rename ${displayName(e)}`}
                    className="shrink-0 rounded p-1.5 text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent cursor-pointer opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {e.id === active?.id ? (
                    <span className="shrink-0 p-1.5" title="current machine" aria-label="current machine">
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setEditingId(null); setConfirmingId(e.id); }}
                      aria-label={`remove ${displayName(e)}`}
                      className="shrink-0 rounded p-1.5 text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
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
