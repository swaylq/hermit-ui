'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { getStoredKey, setStoredKey } from '@/app/providers';
import { LoginScreen } from '@/components/login-screen';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NavBar } from '@/components/nav-bar';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [hasKey, setHasKey] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHasKey(!!getStoredKey());
    setHydrated(true);
  }, []);

  if (!hydrated) return null;
  if (!hasKey) {
    return (
      <LoginScreen
        onSubmit={(k) => {
          setStoredKey(k);
          setHasKey(true);
        }}
      />
    );
  }
  return (
    <Authed onLogout={() => { setStoredKey(''); setHasKey(false); }}>
      {children}
    </Authed>
  );
}

function Authed({ onLogout, children }: { onLogout: () => void; children: React.ReactNode }) {
  const me = trpc.machines.me.useQuery(undefined, { retry: false, refetchInterval: 30_000 });

  if (me.error?.data?.code === 'UNAUTHORIZED') {
    return (
      <main className="flex flex-1 items-center justify-center p-4">
        <Card className="max-w-md p-6 space-y-3 border-rose-500/40">
          <p className="text-rose-400 font-medium">invalid key</p>
          <p className="text-sm text-muted-foreground">The stored key was rejected.</p>
          <Button variant="secondary" onClick={onLogout}>
            clear key
          </Button>
        </Card>
      </main>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-screen">
      <NavBar machine={me.data} onLogout={onLogout} />
      <main className="flex-1 w-full">{children}</main>
    </div>
  );
}
