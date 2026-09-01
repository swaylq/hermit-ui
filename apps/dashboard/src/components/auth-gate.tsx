'use client';

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { getKeyring, addMachine, removeMachine, getActiveEntry, fetchMachineByKey, migrateLegacyKey } from '@/lib/keyring';
import { normalizeBase } from '@/lib/api-base';
import { LoginScreen } from '@/components/login-screen';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AppSidebar, SidebarProvider } from '@/components/app-sidebar';
import { SwitchArrival } from '@/components/workspace-switcher';
import { ScopedSidebar } from '@/components/scoped-sidebar';
import { useScope } from '@/lib/use-scope';

/**
 * The app's frame, with nothing in it. Rendered by the server and by the client's
 * first commit (they must agree), then replaced the moment the keyring has been
 * read. Pure static markup — no browser APIs, nothing that can differ between the
 * two renders.
 */
function AppShellSkeleton() {
  return (
    <div className="flex app-h w-full overflow-hidden bg-background text-foreground pwa-safe-t pwa-safe-x">
      <div className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar lg:block" />
      <div className="flex-1 min-w-0 min-h-0" />
    </div>
  );
}

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

  // Not `null`. The shell is server-rendered EMPTY (the keyring lives in
  // localStorage, which the server cannot read), so the first client render has to
  // match that or hydration mismatches — the gate itself is structural and can't be
  // removed. What it doesn't have to be is invisible: measured on a machine switch,
  // the last JS chunk finishes at ~117ms but `<main>` doesn't reach the DOM until
  // ~148ms, and before that the window is blank. A static frame paints as soon as
  // the HTML arrives instead, so the app has shape while it boots.
  //
  // Deliberately no fake rows: a skeleton that guesses at content and then changes
  // reads worse than one that just holds the geometry.
  if (!hydrated) return <AppShellSkeleton />;

  // A share-link landing (/s/<token>) redeems the token and bootstraps its OWN
  // scoped keyring entry, so it must render before any key exists — skip the gate
  // entirely (no sidebar/shell; it's a standalone "opening…" screen that then
  // hard-navigates into the agent).
  if (pathname?.startsWith('/s/')) return <>{children}</>;

  if (count === 0) {
    return (
      <LoginScreen
        onSubmit={async (k, baseRaw) => {
          let origin: string;
          try {
            origin = normalizeBase(baseRaw);
          } catch (ex) {
            return ex instanceof Error ? ex.message : 'bad backend address';
          }
          // Distinguish "key rejected" from "never answered" — a cross-origin
          // sign-in fails with a network error when the far end doesn't list
          // this origin in CORS_ALLOW_ORIGINS.
          let reached = true;
          const m = await fetchMachineByKey(k, origin).catch(() => {
            reached = false;
            return null;
          });
          if (!m) {
            if (!reached) return origin ? `can't reach ${origin} (CORS?)` : "can't reach the server";
            return 'invalid key';
          }
          addMachine({ id: m.id, name: m.name, key: k, hostname: m.hostname, baseUrl: origin || null });
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
        <div className="flex app-h w-full overflow-hidden bg-background text-foreground pwa-safe-t pwa-safe-x animate-in fade-in-0 duration-150">
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
      {/* The arriving half of a machine switch — see SwitchArrival. Mounted here
          because this is the outermost thing that renders on every authed page,
          so the fade covers the whole app regardless of route. */}
      <SwitchArrival />
      <div className="flex app-h w-full overflow-hidden bg-background text-foreground pwa-safe-t pwa-safe-x animate-in fade-in-0 duration-150">
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
  const inBounds =
    (pathname.startsWith('/chat') && !pathname.startsWith('/chat/terminal')) ||
    (pathname.startsWith('/agents') && search.get('name') === agentName);
  useEffect(() => {
    if (!inBounds) window.location.replace(`/chat?agent=${encodeURIComponent(agentName)}`);
  }, [inBounds, agentName]);
  if (!inBounds) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Redirecting…</div>;
  return <>{children}</>;
}
