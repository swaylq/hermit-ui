'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

// onSubmit validates the key (resolves the machine) and returns an error string
// to display, or null on success (the caller navigates away).
export function LoginScreen({ onSubmit }: { onSubmit: (k: string) => Promise<string | null> }) {
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key) return;
    setBusy(true);
    setErr('');
    const msg = await onSubmit(key);
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
          {err && <p className="text-xs text-rose-400">{err}</p>}
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
