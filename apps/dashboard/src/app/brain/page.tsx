'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { SessionPane } from '@/app/chat/page';

// The Brain workspace — Chat view. The sidebar swaps to brain mode (its menu +
// the brain's conversations — see app-sidebar). No landing page: like /chat, this
// drops straight into the most-recent conversation. Memory + Dispatches are
// sibling routes (/brain/memory, /brain/dispatch).
export default function BrainPage() {
  return (
    <Suspense fallback={null}>
      <BrainPageInner />
    </Suspense>
  );
}

function BrainPageInner() {
  const search = useSearchParams();
  const sessionParam = search.get('session');
  if (sessionParam) return <SessionPane key={sessionParam} sessionId={sessionParam} />;
  return <BrainChatLanding />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span aria-hidden className="logo-crab-mono h-5 w-5 bg-foreground" />
        <span className="text-sm font-medium text-foreground">Brain</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}

const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{children}</div>
);

function BrainChatLanding() {
  const router = useRouter();
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 15_000 });
  const brain = (agents.data ?? []).find((a) => a.isOrchestrator);
  const sessions = trpc.chat.listSessions.useQuery(
    { agentName: brain?.name },
    { enabled: !!brain, refetchInterval: 10_000 },
  );
  // listSessions is newest-first; default into the most recent open conversation.
  const latest = (sessions.data ?? []).find((s) => !s.closedAt) ?? sessions.data?.[0];
  useEffect(() => {
    if (latest) router.replace(`/brain?session=${encodeURIComponent(latest.id)}`);
  }, [latest, router]);

  if (agents.isPending) return <Shell><Centered>loading…</Centered></Shell>;
  if (!brain) return <Shell><BrainSetup /></Shell>;
  if (sessions.isPending) return <Shell><Centered>loading…</Centered></Shell>;
  if (latest) return <Shell><Centered>opening…</Centered></Shell>;
  return <Shell><EmptyChat brainName={brain.name} /></Shell>;
}

function EmptyChat({ brainName }: { brainName: string }) {
  const create = trpc.chat.createSession.useMutation();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const s = await create.mutateAsync({ agentName: brainName });
      window.location.href = `/brain?session=${encodeURIComponent(s.id)}`;
    } catch {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto mt-12 max-w-md space-y-4 p-8 text-center">
      <span aria-hidden className="logo-crab-mono mx-auto block h-12 w-12 bg-foreground" />
      <h2 className="text-base font-medium text-foreground">No conversations yet</h2>
      <p className="text-sm text-muted-foreground">Start talking to Brain — give it a goal and it routes the work to the right agents.</p>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="inline-flex h-9 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer"
      >
        {busy ? '…' : 'New Brain chat'}
      </button>
    </div>
  );
}

function BrainSetup() {
  const utils = trpc.useUtils();
  const setup = trpc.agents.setupBrain.useMutation();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setup.mutateAsync();
      await utils.agents.list.invalidate();
      window.location.href = '/brain';
    } catch (e) {
      setBusy(false);
      // eslint-disable-next-line no-alert
      alert(`Brain: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div className="mx-auto mt-12 max-w-md space-y-4 p-8 text-center">
      <span aria-hidden className="logo-crab-mono mx-auto block h-14 w-14 bg-foreground" />
      <h2 className="text-lg font-medium text-foreground">No Brain yet</h2>
      <p className="text-sm text-muted-foreground">
        Brain is this machine&apos;s orchestrator — it does no work itself. It routes tasks to the
        other agents on this machine and digests their activity into its own memory. Set it up to
        direct it from here.
      </p>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-flex h-9 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer"
      >
        {busy ? 'Setting up…' : 'Set up Brain'}
      </button>
    </div>
  );
}
