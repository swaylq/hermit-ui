'use client';

import { useState } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { fetchMachineByKey, addMachine } from '@/lib/keyring';
import { normalizeBase } from '@/lib/api-base';

// Add a machine key to the browser keyring: paste an X-Asst-Key, validate it via
// fetchMachineByKey, store it, then let the caller navigate (a hard reload that
// rebuilds the tRPC client with the new active key AND its backend).
//
// The optional backend field is what lets ONE installed PWA drive several
// dashboard deployments: leave it blank for a machine on this dashboard, or
// enter the other dashboard's address (https://hermit.zhinan.tech) to add a
// machine that lives there. That deployment must list this origin in its
// CORS_ALLOW_ORIGINS, otherwise validation fails as "can't reach". Shared by the full
// WorkspaceSwitcher and the scoped agent-share sidebar — a share recipient who's
// been handed a machine key can upgrade in place without the incognito/devtools
// dance. The server still enforces the boundary; a valid key is the only way in.
export function AddMachine({ onAdded, label = 'Add machine' }: { onAdded: () => void; label?: string }) {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key) return;
    let origin: string;
    try {
      origin = normalizeBase(base);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'bad backend address');
      return;
    }
    setBusy(true);
    setErr('');
    // Separate "rejected the key" from "never got an answer": a cross-origin
    // add fails with a network error when the far end has no CORS allowance for
    // us, and "invalid key" would send you looking in entirely the wrong place.
    let reached = true;
    const m = await fetchMachineByKey(key, origin).catch(() => {
      reached = false;
      return null;
    });
    setBusy(false);
    if (!m) {
      setErr(reached ? 'invalid key' : origin ? `can't reach ${origin} (CORS?)` : "can't reach the server");
      return;
    }
    addMachine({ id: m.id, name: m.name, key, hostname: m.hostname, alias: m.alias, baseUrl: origin || null });
    onAdded();
  };

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground cursor-pointer"
      >
        <Plus className="h-3.5 w-3.5" /> {label}
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
        className="w-full rounded-md bg-background border border-sidebar-border px-2 py-1.5 text-base font-mono outline-none focus:border-sidebar-foreground/40 md:py-1 md:text-xs"
      />
      <input
        type="url"
        inputMode="url"
        autoComplete="off"
        value={base}
        onChange={(e) => setBase(e.target.value)}
        placeholder="other dashboard (blank = this one)"
        className="w-full rounded-md bg-background border border-sidebar-border px-2 py-1.5 text-base font-mono outline-none focus:border-sidebar-foreground/40 md:py-1 md:text-xs"
      />
      {err && <p className="text-[10px] text-rose-400 px-1">{err}</p>}
      <div className="flex items-center gap-1">
        <button
          type="submit"
          disabled={busy || !key}
          className="flex flex-1 items-center justify-center gap-1 rounded-md bg-sidebar-accent px-2 py-1 text-xs disabled:opacity-50 cursor-pointer"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />} Add
        </button>
        <button
          type="button"
          onClick={() => { setAdding(false); setKey(''); setBase(''); setErr(''); }}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-sidebar-foreground cursor-pointer"
        >
          cancel
        </button>
      </div>
    </form>
  );
}
