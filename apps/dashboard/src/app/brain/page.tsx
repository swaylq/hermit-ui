'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { SessionPane } from '@/app/chat/page';
import { ArrowRight } from 'lucide-react';

// The dedicated 义脑 / Brain workspace. The sidebar swaps to brain mode here (its
// own "New 义脑 chat" + the brain's conversations — see app-sidebar). This page is
// the main area: a brain conversation when ?session=<id> is set, otherwise the
// command center (give the brain a goal + the machine overview).
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
  // A selected brain conversation renders the full chat UI (its own header).
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
        <span className="text-sm font-medium text-foreground">义脑 / Brain</span>
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
      alert(`义脑: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div className="mx-auto mt-12 max-w-md space-y-4 p-8 text-center">
      <span aria-hidden className="logo-crab-mono mx-auto block h-14 w-14 bg-foreground" />
      <h2 className="text-lg font-medium text-foreground">还没有义脑</h2>
      <p className="text-sm text-muted-foreground">
        义脑是这台机器的调度中枢——它不亲自干活，而是把任务派给本机其它 agent，并定期把它们的动态盘点进自己的 memory。设置后从这里指挥它。
      </p>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-flex h-9 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer"
      >
        {busy ? '设置中…' : '设置义脑'}
      </button>
    </div>
  );
}

type SessionRow = inferRouterOutputs<AppRouter>['chat']['listSessions'][number];
const byRecent = (a: SessionRow, b: SessionRow) =>
  new Date(b.lastMessageAt ?? b.startedAt).getTime() - new Date(a.lastMessageAt ?? a.startedAt).getTime();

function BrainPanel({ brainName }: { brainName: string }) {
  const sessions = trpc.chat.listSessions.useQuery({}, { refetchInterval: 5_000 });
  const all = sessions.data ?? [];
  // Dispatch sessions live on the TARGET agent, titled "义脑 → <agent>" (set by
  // the dispatch tool) — the brain's outstanding/recent hand-offs.
  const dispatches = all.filter((s) => (s.title ?? '').startsWith('义脑 →')).sort(byRecent).slice(0, 12);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <CommandBox brainName={brainName} />
      <Roster />
      <Dispatches dispatches={dispatches} />
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
      // Land on the new brain conversation, inside the brain workspace.
      window.location.href = `/brain?session=${encodeURIComponent(s.id)}`;
    } catch (e) {
      setBusy(false);
      // eslint-disable-next-line no-alert
      alert(`义脑: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="text-[13px] font-medium text-foreground">给义脑下达目标</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(); } }}
        rows={3}
        placeholder="比如：整理今天各 agent 的进展并汇报；或把「X 任务」派给合适的 agent…"
        className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus-visible:border-foreground/30 focus-visible:ring-1 focus-visible:ring-foreground/15"
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">⌘/Ctrl + Enter 发送 · 会开一个新对话</span>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !text.trim()}
          className="inline-flex h-8 items-center justify-center rounded-lg bg-foreground px-3 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40 cursor-pointer"
        >
          {busy ? '…' : '发送'}
        </button>
      </div>
    </div>
  );
}

function SectionCard({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-baseline gap-1.5 border-b border-border px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
        <span>{title}</span>
        {count != null && <span className="tabular-nums text-muted-foreground/50">{count}</span>}
      </div>
      <div className="p-2">{children}</div>
    </section>
  );
}

function Roster() {
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 15_000 });
  const workers = (agents.data ?? []).filter((a) => !a.isOrchestrator);
  return (
    <SectionCard title="管理的 agent" count={workers.length}>
      {workers.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">本机还没有其它 agent。</p>
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
    </SectionCard>
  );
}

function Dispatches({ dispatches }: { dispatches: SessionRow[] }) {
  return (
    <SectionCard title="最近派发" count={dispatches.length}>
      {dispatches.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">还没有派发记录。义脑把一次性任务派给 agent 后会出现在这里。</p>
      ) : (
        <ul className="space-y-px">
          {dispatches.map((s) => (
            <li key={s.id}>
              <Link
                href={`/chat?session=${encodeURIComponent(s.id)}`}
                className="group flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-accent cursor-pointer"
                title={s.title ?? undefined}
              >
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', s.alive ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500')} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{s.title}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
                <span className="shrink-0 text-[10px] font-mono tabular-nums text-muted-foreground/60">{relTime(s.lastMessageAt ?? s.startedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
