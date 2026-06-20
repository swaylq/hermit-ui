'use client';

// Secrets — the active machine's encrypted store (~/.claude/global-memory/
// secrets.age), surfaced read/write. The dashboard runs on the VPS but the age
// master key lives in the machine's Keychain, so every op is forwarded to that
// machine's gateway (trpc.secrets.* → control-WS → `secret` CLI). A value is
// fetched only on an explicit Reveal click, held in local state, and auto-hidden
// after 8s — it never sits in the list payload.

import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Trash2, Plus, Loader2, KeyRound } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const AUTO_HIDE_MS = 8_000;

export function SecretsSection() {
  const utils = trpc.useUtils();
  const list = trpc.secrets.list.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const reveal = trpc.secrets.reveal.useMutation();
  const setSecret = trpc.secrets.set.useMutation({ onSuccess: () => utils.secrets.list.invalidate() });
  const remove = trpc.secrets.remove.useMutation({ onSuccess: () => utils.secrets.list.invalidate() });

  const [shown, setShown] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Clear all pending auto-hide timers on unmount.
  useEffect(() => {
    const t = timers.current;
    return () => Object.values(t).forEach(clearTimeout);
  }, []);

  const hide = (key: string) => {
    setShown((s) => {
      const n = { ...s };
      delete n[key];
      return n;
    });
    if (timers.current[key]) {
      clearTimeout(timers.current[key]);
      delete timers.current[key];
    }
  };

  const onReveal = async (key: string) => {
    if (shown[key] !== undefined) {
      hide(key);
      return;
    }
    setBusy(key);
    try {
      const r = await reveal.mutateAsync({ key });
      setShown((s) => ({ ...s, [key]: r.value }));
      if (timers.current[key]) clearTimeout(timers.current[key]);
      timers.current[key] = setTimeout(() => hide(key), AUTO_HIDE_MS);
    } catch {
      /* error surfaced via reveal.error below */
    } finally {
      setBusy(null);
    }
  };

  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const validKey = /^[A-Za-z0-9_]+$/.test(newKey);
  const onAdd = async () => {
    if (!validKey || !newVal) return;
    try {
      await setSecret.mutateAsync({ key: newKey, value: newVal });
      setNewKey('');
      setNewVal('');
    } catch {
      /* surfaced via setSecret.error */
    }
  };

  const keys = list.data?.keys ?? [];

  return (
    <section className="shrink-0 space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <KeyRound className="size-3.5" /> Secrets
        </h3>
        <span className="text-[11px] text-muted-foreground">
          encrypted store · decrypted by this machine&apos;s gateway · revealed values auto-hide
        </span>
      </div>

      {/* Add a secret — value via a password field, sent to the gateway over stdin. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value.trim())}
          placeholder="KEY_NAME"
          spellCheck={false}
          className="h-7 w-40 font-mono text-xs"
        />
        <Input
          value={newVal}
          onChange={(e) => setNewVal(e.target.value)}
          type="password"
          placeholder="value"
          className="h-7 w-56 text-xs"
        />
        <Button size="sm" variant="outline" disabled={!validKey || !newVal || setSecret.isPending} onClick={onAdd}>
          {setSecret.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add
        </Button>
        {newKey && !validKey && <span className="text-[11px] text-destructive">A–Z a–z 0–9 _ only</span>}
      </div>

      {/* Keys (names only; values fetched on demand). */}
      <div className="divide-y divide-border rounded-md border border-border">
        {list.isPending ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">loading…</div>
        ) : list.error ? (
          <div className="px-3 py-2 text-xs text-destructive">{list.error.message}</div>
        ) : keys.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No secrets yet.</div>
        ) : (
          keys.map((key) => (
            <div key={key} className="flex items-center gap-2 px-3 py-1.5">
              <span className="w-48 shrink-0 truncate font-mono text-xs text-foreground">{key}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {shown[key] !== undefined ? shown[key] : '••••••••'}
              </span>
              {shown[key] !== undefined && <span className="shrink-0 text-[10px] text-amber-600">visible — auto-hides</span>}
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy === key}
                title={shown[key] !== undefined ? 'hide' : 'reveal'}
                onClick={() => onReveal(key)}
              >
                {busy === key ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : shown[key] !== undefined ? (
                  <EyeOff className="size-3.5" />
                ) : (
                  <Eye className="size-3.5" />
                )}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                title="delete"
                disabled={remove.isPending}
                onClick={() => {
                  if (confirm(`Delete secret "${key}"? This removes it from the encrypted store.`)) remove.mutate({ key });
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>
      {(reveal.error || setSecret.error || remove.error) && (
        <p className="text-[11px] text-destructive">{(reveal.error || setSecret.error || remove.error)?.message}</p>
      )}
    </section>
  );
}
