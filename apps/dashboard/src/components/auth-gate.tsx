'use client';

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { getKeyring, addMachine, removeMachine, getActiveEntry, fetchMachineByKey, migrateLegacyKey } from '@/lib/keyring';
import { LoginScreen } from '@/components/login-screen';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AppSidebar, SidebarProvider } from '@/components/app-sidebar';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // Await the legacy-key migration before checking the keyring, so an existing
    // single-key user is folded in (not bounced to the login screen).
    void (async () => {
      await migrateLegacyKey();
      setCount(getKeyring().length);
      setHydrated(true);
    })();
  }, []);

  if (!hydrated) return null;

  if (count === 0) {
    return (
      <LoginScreen
        onSubmit={async (k) => {
          const m = await fetchMachineByKey(k).catch(() => null);
          if (!m) return 'invalid key';
          addMachine({ id: m.id, name: m.name, key: k, hostname: m.hostname });
          window.location.href = '/chat';
          return null;
        }}
      />
    );
  }

  return (
    <Authed
      onSignOut={() => {
        const a = getActiveEntry();
        const next = a ? removeMachine(a.id) : null;
        window.location.href = next ? '/chat' : '/';
      }}
    >
      {children}
    </Authed>
  );
}

function Authed({ onSignOut, children }: { onSignOut: () => void; children: React.ReactNode }) {
  const me = trpc.machines.me.useQuery(undefined, { retry: false, refetchInterval: 30_000 });

  if (me.error?.data?.code === 'UNAUTHORIZED') {
    return (
      <main className="flex flex-1 items-center justify-center p-4">
        <Card className="max-w-md p-6 space-y-3 border-rose-500/40">
          <p className="text-rose-400 font-medium">invalid key</p>
          <p className="text-sm text-muted-foreground">The active machine&apos;s key was rejected.</p>
          <Button variant="secondary" onClick={onSignOut}>
            remove this machine
          </Button>
        </Card>
      </main>
    );
  }

  return (
    <SidebarProvider>
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        <AppSidebar machine={me.data} onLogout={onSignOut} />
        <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">{children}</main>
      </div>
    </SidebarProvider>
  );
}
