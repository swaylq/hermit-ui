'use client';

// Host-health chip (sidebar header) + the panel it opens. Shows this machine's
// RAM / swap / load and its heaviest chat sessions, so memory pressure is visible
// before it becomes a gray-failure avalanche (the macmini1 incident).
//
// The panel is a bare createPortal overlay (NOT base-ui Dialog) with self-managed
// Esc + scroll-lock + an opaque popup — the dashboard's established overlay pattern
// (see image-lightbox.tsx / the base-ui overlay-quirks note).

import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { Activity, X, Moon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
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

export function HostHealthChip({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const stat = trpc.hosts.stat.useQuery(undefined, { refetchInterval: 15_000 }).data;
  const stale = isStale(stat?.sampledAt);
  const health: HostHealth = stat ? hostHealth(stat) : 'green';
  const dot = !stat || stale ? 'bg-muted-foreground/40' : DOT[health];
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Host health"
        aria-label="Host health"
        className={cn(
          'group relative inline-flex items-center justify-center p-1.5 rounded-md transition-colors cursor-pointer shrink-0',
          'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
          collapsed && 'lg:hidden',
        )}
      >
        <Activity className="h-4 w-4" />
        <span
          aria-hidden="true"
          className={cn(
            'absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-sidebar',
            dot,
            health === 'red' && !stale && 'animate-pulse',
          )}
        />
      </button>
      {open && <HostHealthPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function Bar({ usedPct, tone }: { usedPct: number; tone: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${Math.max(0, Math.min(100, usedPct))}%` }} />
    </div>
  );
}

function HostHealthPanel({ onClose }: { onClose: () => void }) {
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const stale = isStale(stat?.sampledAt);
  const health: HostHealth = stat ? hostHealth(stat) : 'green';
  const ramUsedPct = stat?.ramTotalMb ? (1 - (stat.ramFreeMb ?? 0) / stat.ramTotalMb) * 100 : 0;
  const swapUsedPct = stat?.swapTotalMb ? ((stat.swapUsedMb ?? 0) / stat.swapTotalMb) * 100 : 0;
  const withRss = sessions.filter((s) => s.rssMb != null);
  const totalGb = withRss.reduce((a, s) => a + (s.rssMb ?? 0), 0) / 1024;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-start justify-center bg-black/60 p-4 sm:p-8" onClick={onClose}>
      <div
        className="mt-12 w-full max-w-md rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full', stale ? 'bg-muted-foreground/40' : DOT[health])} />
            <span className="text-sm font-medium">Host health</span>
            <span className={cn('text-xs', stale ? 'text-muted-foreground' : TEXT[health])}>
              {stale ? 'Stale' : LABEL[health]}
            </span>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted cursor-pointer" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3 text-sm">
          {!stat ? (
            <p className="text-xs text-muted-foreground">No host metrics yet — the gateway reports every ~30s.</p>
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className="border-t border-border px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Top memory sessions</span>
            <span className="text-xs tabular-nums text-muted-foreground">{withRss.length} live · {totalGb.toFixed(1)} GB</span>
          </div>
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {withRss.length === 0 && <p className="py-2 text-xs text-muted-foreground">No live sessions reporting memory.</p>}
            {withRss.map((s) => {
              const hibernated = s.hibernatedAt != null;
              return (
                <div key={s.id} className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-xs', hibernated && 'opacity-50')}>
                  <span className="w-14 shrink-0 text-right font-mono tabular-nums">{s.rssMb} MB</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{s.agentName}</span>
                    {s.title ? <span className="text-muted-foreground"> · {s.title}</span> : null}
                  </span>
                  {hibernated ? (
                    <Moon className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="hibernated" />
                  ) : s.alive ? (
                    <button
                      type="button"
                      title="Hibernate — free memory; wakes on send"
                      onClick={() => hibernate.mutate({ id: s.id })}
                      className="shrink-0 rounded p-0.5 text-muted-foreground/50 hover:bg-muted hover:text-foreground cursor-pointer"
                    >
                      <Moon className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">{fmtIdle(s.lastMessageAt)}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs">
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
              className="w-12 rounded border border-border bg-background px-1.5 py-0.5 text-right text-foreground tabular-nums"
            />
            h
          </label>
          <button
            type="button"
            onClick={() => reapNow.mutate({ hours: reapConfig?.idleReapHours ?? 24 })}
            disabled={reapNow.isPending}
            className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer disabled:opacity-50"
          >
            {reapNow.isPending ? 'Hibernating…' : reapNow.data ? `Slept ${reapNow.data.count}` : 'Hibernate idle now'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
