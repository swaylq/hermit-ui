'use client';

import { useState } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { fetchMachineByKey, addMachine } from '@/lib/keyring';

// Add a machine key to the browser keyring: paste an X-Asst-Key, validate it via
// fetchMachineByKey, store it, then let the caller navigate (a hard reload that
// rebuilds the tRPC client with the new active key). Shared by the full
// WorkspaceSwitcher and the scoped agent-share sidebar — a share recipient who's
// been handed a machine key can upgrade in place without the incognito/devtools
// dance. The server still enforces the boundary; a valid key is the only way in.
export function AddMachine({ onAdded, label = 'Add machine' }: { onAdded: () => void; label?: string }) {
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
        className="w-full rounded-md bg-background border border-sidebar-border px-2 py-1 text-xs font-mono outline-none focus:border-sidebar-foreground/40"
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
          onClick={() => { setAdding(false); setKey(''); setErr(''); }}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-sidebar-foreground cursor-pointer"
        >
          cancel
        </button>
      </div>
    </form>
  );
}
