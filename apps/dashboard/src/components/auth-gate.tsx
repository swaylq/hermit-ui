'use client';

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { getKeyring, addMachine, removeMachine, getActiveEntry, fetchMachineByKey, migrateLegacyKey } from '@/lib/keyring';
import { LoginScreen } from '@/components/login-screen';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AppSidebar, SidebarProvider } from '@/components/app-sidebar';
import { ScopedSidebar } from '@/components/scoped-sidebar';
import { useScope } from '@/lib/use-scope';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const pathname = usePathname();

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

  // A share-link landing (/s/<token>) redeems the token and bootstraps its OWN
  // scoped keyring entry, so it must render before any key exists — skip the gate
  // entirely (no sidebar/shell; it's a standalone "opening…" screen that then
  // hard-navigates into the agent).
  if (pathname?.startsWith('/s/')) return <>{children}</>;

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
  const scope = useScope();
  // machines.me is owner-only (machineProcedure) → skip it in a scoped session.
  const me = trpc.machines.me.useQuery(undefined, { retry: false, refetchInterval: 30_000, enabled: !scope.scoped });

  if (!scope.scoped && me.error?.data?.code === 'UNAUTHORIZED') {
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

  // Scoped agent-share session: stripped shell (ScopedSidebar) + a route bound so
  // the holder can only stay on /chat* or /agents?name=<their agent>.
  if (scope.scoped && scope.agentName) {
    return (
      <SidebarProvider>
        <div className="flex app-h w-full overflow-hidden bg-background text-foreground pwa-safe-t pwa-safe-x">
          <ScopedSidebar agentName={scope.agentName} />
          <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
            <ScopedBounds agentName={scope.agentName}>{children}</ScopedBounds>
          </main>
        </div>
      </SidebarProvider>
    );
  }

  return (
    <SidebarProvider>
      <div className="flex app-h w-full overflow-hidden bg-background text-foreground pwa-safe-t pwa-safe-x">
        <AppSidebar />
        <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">{children}</main>
      </div>
    </SidebarProvider>
  );
}

// In a scoped session, allow only /chat* and the agent's own detail
// (/agents?name=<agent>). Anything else (other agents, /cron, /skills, /brain,
// /market, /global-memory) is redirected back to the agent's chat. The server
// also 403s those — this is the UX half of the boundary.
function ScopedBounds({ agentName, children }: { agentName: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const inBounds = pathname.startsWith('/chat') || (pathname.startsWith('/agents') && search.get('name') === agentName);
  useEffect(() => {
    if (!inBounds) window.location.replace(`/chat?agent=${encodeURIComponent(agentName)}`);
  }, [inBounds, agentName]);
  if (!inBounds) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Redirecting…</div>;
  return <>{children}</>;
}
