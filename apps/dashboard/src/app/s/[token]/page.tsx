'use client';

// Agent share landing — dash.swaylab.ai/s/<token>. Validates the share token,
// drops it into the browser keyring as a SCOPED entry (so it flows as the active
// X-Asst-Key like any key), strips the token from the URL, then hard-navigates
// into the agent's chat. From there the whole app is scoped to that one agent
// (server-enforced; the shell is hidden by useScope). AuthGate lets /s/* through
// before any key exists (see auth-gate.tsx).

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { addMachine } from '@/lib/keyring';

export default function ShareLandingPage() {
  const params = useParams<{ token: string }>();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token ?? '');
  const redeem = trpc.share.redeem.useMutation();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current || !token) return;
    ran.current = true; // guard React StrictMode's double-invoke
    void (async () => {
      try {
        const { agentName, machineName } = await redeem.mutateAsync({ token });
        addMachine({
          id: `shr-${token.slice(0, 12)}`,
          name: agentName,
          key: token,
          alias: `${agentName} · ${machineName}`,
          scoped: true,
          agentName,
        });
        // Don't leave the token sitting in history / proxy logs.
        window.history.replaceState(null, '', '/chat');
        // Full load so the tRPC client re-reads the now-active scoped key.
        window.location.href = `/chat?agent=${encodeURIComponent(agentName)}`;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'invalid or expired share link');
      }
    })();
  }, [token, redeem]);

  return (
    <main className="flex app-h w-full items-center justify-center p-6 text-center bg-background text-foreground">
      {error ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-destructive">This share link isn&apos;t valid.</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Opening shared agent…</p>
      )}
    </main>
  );
}
