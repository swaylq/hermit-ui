'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { SessionPane } from '@/app/chat/page';

// The Brain workspace — Chat view. The sidebar swaps to brain mode (its menu +
// the brain's conversations — see app-sidebar). This page: a brain conversation
// when ?session=<id>, otherwise the command center (give the brain a goal + the
// roster of managed agents). Memory + Dispatches are sibling routes.
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
  return <BrainHome />;
}

function BrainHome() {
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 15_000 });
  const brain = (agents.data ?? []).find((a) => a.isOrchestrator);
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span aria-hidden className="logo-crab-mono h-5 w-5 bg-foreground" />
        <span className="text-sm font-medium text-foreground">Brain</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {agents.isPending ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">loading…</div>
        ) : brain ? (
          <BrainPanel brainName={brain.name} />
        ) : (
          <BrainSetup />
        )}
      </div>
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

function BrainPanel({ brainName }: { brainName: string }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <CommandBox brainName={brainName} />
      <Roster />
    </div>
  );
}

function CommandBox({ brainName }: { brainName: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const create = trpc.chat.createSession.useMutation();
  const send = trpc.chat.send.useMutation();
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const s = await create.mutateAsync({ agentName: brainName });
      await send.mutateAsync({ sessionId: s.id, text: t });
      window.location.href = `/brain?session=${encodeURIComponent(s.id)}`;
    } catch (e) {
      setBusy(false);
      // eslint-disable-next-line no-alert
      alert(`Brain: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="text-[13px] font-medium text-foreground">Give Brain a goal</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(); } }}
        rows={3}
        placeholder="e.g. summarize what each agent did today and report back; or route task X to the right agent…"
        className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus-visible:border-foreground/30 focus-visible:ring-1 focus-visible:ring-foreground/15"
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">⌘/Ctrl + Enter to send · opens a new conversation</span>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !text.trim()}
          className="inline-flex h-8 items-center justify-center rounded-lg bg-foreground px-3 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40 cursor-pointer"
        >
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function Roster() {
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 15_000 });
  const workers = (agents.data ?? []).filter((a) => !a.isOrchestrator);
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-baseline gap-1.5 border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
        <span>Managed agents</span>
        <span className="tabular-nums text-muted-foreground/50">{workers.length}</span>
      </div>
      <div className="p-2">
        {workers.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">No other agents on this machine yet.</p>
        ) : (
          <ul className="space-y-px">
            {workers.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/agents?name=${encodeURIComponent(a.name)}`}
                  className="group flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-accent cursor-pointer"
                >
                  <span
                    className={cn('mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full', a.activeSessionCount > 0 ? 'bg-emerald-500' : 'border border-muted-foreground/40')}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground/90">{a.name}</span>
                  <span className="shrink-0 text-[10px] font-mono tabular-nums text-muted-foreground/60">
                    {a.activeSessionCount > 0 ? `${a.activeSessionCount} active` : `${a.sessionCount} sess`} · {a.skillNames.length} skill
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
