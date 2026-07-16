'use client';

import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { trpc } from '@/lib/trpc';
import { relTime } from '@/lib/format';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { FileList, type FileItem } from '@/components/file-detail';
import { MemoryDir } from '@/components/brain-memory';

// Brain · Dream — see the daily "dream" in action: its persistent reflections
// (memory/dreams/<date>.md, the journal, read from the brain's workspace) and the
// cron run history (when it dreamed + the output it produced), plus a "Dream now"
// button to trigger one.
const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{children}</div>
);

const everyLabel = (sec: number) =>
  sec % 86_400 === 0 ? (sec === 86_400 ? 'daily' : `every ${sec / 86_400}d`) : `every ${Math.round(sec / 3600)}h`;

// Change the dream cadence. cron.update reschedules nextFire from the last run,
// so a shorter interval dreams sooner.
function FrequencySelect({ cronId, current }: { cronId: string; current: number }) {
  const utils = trpc.useUtils();
  const update = trpc.cron.update.useMutation({
    onSuccess: () => { void utils.cron.list.invalidate(); void utils.cron.get.invalidate(); },
  });
  const OPTIONS: Array<{ v: number; l: string }> = [
    { v: 21_600, l: 'Every 6h' },
    { v: 43_200, l: 'Every 12h' },
    { v: 86_400, l: 'Daily' },
    { v: 172_800, l: 'Every 2 days' },
    { v: 604_800, l: 'Weekly' },
  ];
  const hasCurrent = OPTIONS.some((o) => o.v === current);
  return (
    <select
      aria-label="dream frequency"
      value={String(current)}
      onChange={(e) => update.mutate({ id: cronId, intervalSec: Number(e.target.value) })}
      disabled={update.isPending}
      className="h-8 rounded-lg border border-border bg-background px-2 text-[13px] text-foreground outline-none transition-colors hover:border-foreground/30 focus-visible:border-foreground/40 disabled:opacity-50 cursor-pointer"
    >
      {!hasCurrent && <option value={String(current)}>{everyLabel(current)}</option>}
      {OPTIONS.map((o) => <option key={o.v} value={String(o.v)}>{o.l}</option>)}
    </select>
  );
}

export default function BrainDreamPage() {
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 30_000 });
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
  // includeRunOutput: this journal renders each run's output inline (FileList body).
  const detail = trpc.cron.get.useQuery({ id: dreamCron?.id ?? '', includeRunOutput: true }, { enabled: !!dreamCron, refetchInterval: 10_000 });
  const runs = detail.data?.runs ?? [];
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
          <div className="flex shrink-0 items-center gap-2">
            <FrequencySelect cronId={dreamCron.id} current={dreamCron.intervalSec} />
            <button
              type="button"
              onClick={() => runNow.mutate({ id: dreamCron.id })}
              disabled={runNow.isPending}
              className="inline-flex h-8 items-center justify-center rounded-lg bg-foreground px-3 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40 cursor-pointer"
            >
              {runNow.isPending ? '…' : 'Dream now'}
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No dream scheduled. Newly set-up Brains get a daily dream automatically; an older Brain may not have one.
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">What each dream consolidated — Brain&apos;s daily reflections.</p>
        <MemoryDir
          agentName={brainName}
          dir="memory/dreams"
          title="Dream journal"
          sortDesc
          labelOf={(n) => n.replace(/\.md$/i, '')}
          emptyHint="No dreams yet. Brain writes one each time it dreams — hit “Dream now” to trigger one."
        />
      </div>

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
