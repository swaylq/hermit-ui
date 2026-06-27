'use client';

// Host-health view — the full RAM/swap/load + per-session memory + reap controls,
// rendered inline on the Settings → System tab (relocated from the old sidebar
// chip/popover). Reads the same trpc.hosts.* the gateway feeds; health keys on
// free-RAM + load (never swap-used — macOS lazily reclaims swapfiles).

import { Moon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { Card } from '@/components/ui/card';
import { hostHealth, isStale, fmtGB, type HostHealth } from '@/lib/host-health';

const DOT: Record<HostHealth, string> = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-rose-500' };
const TEXT: Record<HostHealth, string> = { green: 'text-emerald-500', amber: 'text-amber-500', red: 'text-rose-500' };
const LABEL: Record<HostHealth, string> = { green: 'Healthy', amber: 'Under pressure', red: 'Critical' };

function fmtIdle(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const ms = Date.now() - (typeof d === 'string' ? Date.parse(d) : d.getTime());
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const h = ms / 3.6e6;
  if (h < 1) return `${Math.max(1, Math.round(ms / 6e4))}m`;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function Bar({ usedPct, tone }: { usedPct: number; tone: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${Math.max(0, Math.min(100, usedPct))}%` }} />
    </div>
  );
}

export function HostHealthView() {
  const stat = trpc.hosts.stat.useQuery(undefined, { refetchInterval: 10_000 }).data;
  const sessions = trpc.hosts.topSessions.useQuery(undefined, { refetchInterval: 10_000 }).data ?? [];
  const reapConfig = trpc.hosts.reapConfig.useQuery().data;
  const utils = trpc.useUtils();
  const invalidate = () => {
    void utils.hosts.topSessions.invalidate();
    void utils.chat.listSessions.invalidate();
  };
  const hibernate = trpc.chat.requestHibernate.useMutation({ onSuccess: invalidate });
  const reapNow = trpc.chat.reapIdleNow.useMutation({ onSuccess: invalidate });
  const setReap = trpc.hosts.setIdleReapHours.useMutation({ onSuccess: () => void utils.hosts.reapConfig.invalidate() });

  const stale = isStale(stat?.sampledAt);
  const health: HostHealth = stat ? hostHealth(stat) : 'green';
  const ramUsedPct = stat?.ramTotalMb ? (1 - (stat.ramFreeMb ?? 0) / stat.ramTotalMb) * 100 : 0;
  const swapUsedPct = stat?.swapTotalMb ? ((stat.swapUsedMb ?? 0) / stat.swapTotalMb) * 100 : 0;
  const withRss = sessions.filter((s) => s.rssMb != null);
  const totalGb = withRss.reduce((a, s) => a + (s.rssMb ?? 0), 0) / 1024;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full', stale ? 'bg-muted-foreground/40' : DOT[health], health === 'red' && !stale && 'animate-pulse')} />
          <span className="text-sm font-semibold">Host health</span>
          <span className={cn('text-xs', stale ? 'text-muted-foreground' : TEXT[health])}>{stale ? 'Stale' : LABEL[health]}</span>
        </div>
        {!stat ? (
          <p className="text-xs text-muted-foreground">No host metrics yet — the gateway reports every ~30s.</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">RAM free</span>
                <span className="tabular-nums">{fmtGB(stat.ramFreeMb)} / {fmtGB(stat.ramTotalMb)} GB</span>
              </div>
              <Bar usedPct={ramUsedPct} tone={DOT[health]} />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Swap used</span>
                <span className="tabular-nums text-muted-foreground">{fmtGB(stat.swapUsedMb)} / {fmtGB(stat.swapTotalMb)} GB</span>
              </div>
              <Bar usedPct={swapUsedPct} tone="bg-muted-foreground/50" />
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Load (1m)</span>
              <span className="tabular-nums">{stat.loadAvg1?.toFixed(2) ?? '—'} / {stat.cpuCount ?? '—'} cores</span>
            </div>
            {stale && <p className="text-xs text-amber-500">Last sample is stale — the gateway may be down.</p>}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">Top memory sessions</span>
          <span className="text-xs tabular-nums text-muted-foreground">{withRss.length} live · {totalGb.toFixed(1)} GB</span>
        </div>
        <div className="space-y-0.5">
          {withRss.length === 0 && <p className="py-2 text-xs text-muted-foreground">No live sessions reporting memory.</p>}
          {withRss.map((s) => {
            const hibernated = s.hibernatedAt != null;
            return (
              <div key={s.id} className={cn('flex items-center gap-2 rounded-md px-1 py-1.5 text-xs', hibernated && 'opacity-50')}>
                <span className="w-16 shrink-0 text-right font-mono tabular-nums">{s.rssMb} MB</span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{s.agentName}</span>
                  {s.title ? <span className="text-muted-foreground"> · {s.title}</span> : null}
                </span>
                {hibernated ? (
                  <Moon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="hibernated" />
                ) : s.alive ? (
                  <button
                    type="button"
                    title="Hibernate — free memory; wakes on send"
                    onClick={() => hibernate.mutate({ id: s.id })}
                    className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground cursor-pointer"
                  >
                    <Moon className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{fmtIdle(s.lastMessageAt)}</span>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs">
          <label className="flex items-center gap-1.5 text-muted-foreground">
            Auto-reap idle &gt;
            <input
              type="number"
              min={1}
              key={reapConfig?.idleReapHours ?? 'off'}
              defaultValue={reapConfig?.idleReapHours ?? ''}
              onBlur={(e) => {
                const v = e.target.value.trim();
                setReap.mutate({ hours: v ? Math.max(1, Math.round(Number(v))) : null });
              }}
              className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-right text-foreground tabular-nums"
            />
            h <span className="text-muted-foreground/60">(blank = off)</span>
          </label>
          <button
            type="button"
            onClick={() => reapNow.mutate({ hours: reapConfig?.idleReapHours ?? 24 })}
            disabled={reapNow.isPending}
            className="rounded-md border border-border px-2.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer disabled:opacity-50"
          >
            {reapNow.isPending ? 'Hibernating…' : reapNow.data ? `Hibernated ${reapNow.data.count}` : 'Hibernate idle now'}
          </button>
        </div>
      </Card>
    </div>
  );
}
