'use client';

import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { trpc } from '@/lib/trpc';
import { relTime } from '@/lib/format';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { FileList, type FileItem } from '@/components/file-detail';

// Brain · Dream — see the daily "dream" in action: its persistent reflections
// (memory/dreams/<date>.md, the journal) and the cron run history (when it
// dreamed + the output it produced), plus a "Dream now" button to trigger one.
type Mem = { path: string; content: string };

const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{children}</div>
);

const everyLabel = (sec: number) =>
  sec % 86_400 === 0 ? (sec === 86_400 ? 'daily' : `every ${sec / 86_400}d`) : `every ${Math.round(sec / 3600)}h`;

export default function BrainDreamPage() {
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 15_000 });
  const brain = (agents.data ?? []).find((a) => a.isOrchestrator);
  const crons = trpc.cron.list.useQuery(undefined, { refetchInterval: 10_000 });
  const dreamCron = (crons.data ?? []).find((c) => c.agentName === brain?.name && /dream/i.test(c.title ?? ''));

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span aria-hidden className="logo-crab-mono h-5 w-5 bg-foreground" />
        <span className="text-sm font-medium text-foreground">Brain · Dream</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {agents.isPending ? (
          <Centered>loading…</Centered>
        ) : !brain ? (
          <Centered>No Brain yet — set one up from the Chat tab.</Centered>
        ) : (
          <DreamBody brainName={brain.name} dreamCron={dreamCron ?? null} />
        )}
      </div>
    </div>
  );
}

type DreamCron = inferRouterOutputs<AppRouter>['cron']['list'][number] | null;

function DreamBody({ brainName, dreamCron }: { brainName: string; dreamCron: DreamCron }) {
  const utils = trpc.useUtils();
  const runNow = trpc.cron.runNow.useMutation({
    onSuccess: () => {
      void utils.cron.get.invalidate();
      void utils.cron.list.invalidate();
    },
  });
  const detail = trpc.cron.get.useQuery({ id: dreamCron?.id ?? '' }, { enabled: !!dreamCron, refetchInterval: 10_000 });
  const memory = trpc.agents.folderContent.useQuery({ name: brainName, scope: 'memory' }, { refetchInterval: 15_000 });

  const runs = detail.data?.runs ?? [];
  const dreams = ((memory.data ?? []) as Mem[])
    .filter((f) => /^dreams\//i.test(f.path))
    .sort((a, b) => b.path.localeCompare(a.path));

  const journalItems: FileItem[] = dreams.map((f) => ({
    key: f.path,
    label: f.path.replace(/^dreams\//i, '').replace(/\.md$/i, ''),
    body: f.content || null,
  }));
  const runItems: FileItem[] = runs.map((r) => ({
    key: r.id,
    label: `${relTime(r.firedAt)} · ${r.status}${r.durationMs ? ` · ${Math.round(r.durationMs / 1000)}s` : ''}`,
    body: r.output || null,
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      {dreamCron ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-foreground">Daily dream</div>
            <div className="text-[11px] text-muted-foreground">
              {dreamCron.lastFire ? `last dreamed ${relTime(dreamCron.lastFire)}` : 'not dreamed yet'}
              {' · '}next {dreamCron.nextFire ? relTime(dreamCron.nextFire) : '—'}
              {' · '}{everyLabel(dreamCron.intervalSec)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => runNow.mutate({ id: dreamCron.id })}
            disabled={runNow.isPending}
            className="shrink-0 inline-flex h-8 items-center justify-center rounded-lg bg-foreground px-3 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40 cursor-pointer"
          >
            {runNow.isPending ? '…' : 'Dream now'}
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No dream scheduled. Newly set-up Brains get a daily dream automatically; an older Brain may not have one.
        </div>
      )}

      <section className="space-y-2">
        <div className="flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
          <span>Dream journal</span>
          <span className="tabular-nums text-muted-foreground/40">{journalItems.length}</span>
        </div>
        <p className="text-xs text-muted-foreground">What each dream consolidated — Brain&apos;s daily reflections.</p>
        {journalItems.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">No dreams yet. Brain writes one each time it dreams.</p>
        ) : (
          <FileList items={journalItems} />
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
          <span>Dream runs</span>
          <span className="tabular-nums text-muted-foreground/40">{runItems.length}</span>
        </div>
        <p className="text-xs text-muted-foreground">When it dreamed and what it produced (the cron run output).</p>
        {!dreamCron ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">—</p>
        ) : runItems.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">No runs yet — hit “Dream now” to trigger one.</p>
        ) : (
          <FileList items={runItems} />
        )}
      </section>
    </div>
  );
}
