'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

// onSubmit validates the key against `base` (blank = this origin), resolves the
// machine, and returns an error string to display, or null on success (the
// caller navigates away).
//
// The backend field is hidden behind a link: a first key on this dashboard is
// the overwhelmingly common case, and asking everyone for an address they don't
// need is how a login screen starts looking like a config form. It exists so a
// browser whose ONLY machine lives on another deployment can still sign in.
export function LoginScreen({ onSubmit }: { onSubmit: (k: string, base: string) => Promise<string | null> }) {
  const [key, setKey] = useState('');
  const [base, setBase] = useState('');
  const [showBase, setShowBase] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key) return;
    setBusy(true);
    setErr('');
    const msg = await onSubmit(key, base);
    setBusy(false);
    if (msg) setErr(msg);
  };

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-md p-6 space-y-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">asst dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Enter a machine access key.</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
            placeholder="X-Asst-Key"
            className="font-mono"
          />
          {showBase ? (
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="https://other-dashboard (blank = this one)"
              className="font-mono"
            />
          ) : (
            <button
              type="button"
              onClick={() => setShowBase(true)}
              className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            >
              this key is on another dashboard
            </button>
          )}
          {err && <p className="text-xs text-rose-400 animate-in fade-in-0">{err}</p>}
          <Button type="submit" disabled={!key || busy} className="w-full">
            {busy ? 'checking…' : 'sign in'}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Seed first key: <code className="text-foreground">npm run seed</code> in the dashboard directory.
        </p>
      </Card>
    </main>
  );
}
