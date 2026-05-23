'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { UsageSection } from '@/components/usage-section';
import { UsageSparkline } from '@/components/usage-sparkline';

function fmtUSD(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function windowElapsed(start: Date | string, end: Date | string): { pct: number; hours: number } {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  const now = Date.now();
  const total = Math.max(1, e - s);
  const elapsed = Math.max(0, Math.min(total, now - s));
  return {
    pct: (elapsed / total) * 100,
    hours: Math.round(total / 3600_000),
  };
}

function pctBarColor(pct: number): string {
  if (pct >= 90) return 'bg-rose-500';
  if (pct >= 70) return 'bg-amber-400';
  return 'bg-emerald-500';
}

function pctTextColor(pct: number): string {
  if (pct >= 90) return 'text-rose-500';
  if (pct >= 70) return 'text-amber-600 dark:text-amber-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

function AnimatedBar({ pct, color }: { pct: number; color: string }) {
  const target = Math.max(0, Math.min(100, pct));
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setWidth(target), 60);
    return () => clearTimeout(t);
  }, [target]);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted ring-1 ring-foreground/5">
      <div
        className={`h-full rounded-full ${color} transition-[width] duration-[900ms] ease-out`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export default function UsagePage() {
  const me = trpc.machines.me.useQuery();
  const windows = trpc.usage.windows.useQuery(undefined, { refetchInterval: 30_000 });
  const utils = trpc.useUtils();
  const setLimits = trpc.machines.setLimits.useMutation({
    onSuccess: () => {
      utils.machines.me.invalidate();
      setEditing(false);
    },
  });

  const fiveHour = windows.data?.find((w) => w.kind === 'fiveHour');
  const weekly = windows.data?.find((w) => w.kind === 'weekly');

  const [editing, setEditing] = useState(false);
  const [draft5h, setDraft5h] = useState('');
  const [draftWk, setDraftWk] = useState('');

  const limit5h = me.data?.fiveHourLimitUsd ?? null;
  const limitWk = me.data?.weeklyLimitUsd ?? null;
  const pct5h = fiveHour && limit5h ? (fiveHour.costUSD / limit5h) * 100 : null;
  const pctWk = weekly && limitWk ? (weekly.costUSD / limitWk) * 100 : null;

  return (
    <div className="max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Anthropic quota windows · ccusage on the Mac · refreshed every 5min
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft5h(limit5h?.toString() ?? '');
            setDraftWk(limitWk?.toString() ?? '');
            setEditing((v) => !v);
          }}
        >
          {editing ? 'cancel' : 'edit limits'}
        </Button>
      </div>

      {editing && (
        <Card className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Plain dollar amounts for the Anthropic quotas. Leave blank to clear (no pct bar).
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 flex-1 min-w-[200px]">
              <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">5h limit USD</span>
              <Input
                type="number"
                step="0.01"
                value={draft5h}
                onChange={(e) => setDraft5h(e.target.value)}
                placeholder="e.g. 35"
                className="font-mono"
              />
            </label>
            <label className="space-y-1 flex-1 min-w-[200px]">
              <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">weekly limit USD</span>
              <Input
                type="number"
                step="0.01"
                value={draftWk}
                onChange={(e) => setDraftWk(e.target.value)}
                placeholder="e.g. 280"
                className="font-mono"
              />
            </label>
            <Button
              size="sm"
              disabled={setLimits.isPending}
              onClick={() =>
                setLimits.mutate({
                  fiveHourLimitUsd: draft5h === '' ? null : Number(draft5h),
                  weeklyLimitUsd: draftWk === '' ? null : Number(draftWk),
                })
              }
            >
              {setLimits.isPending ? 'saving…' : 'save'}
            </Button>
          </div>
          {setLimits.error && <p className="text-xs text-rose-400">{setLimits.error.message}</p>}
        </Card>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <WindowCard
          title="5-hour block"
          subtitle="Anthropic rolling 5h billing block"
          window={fiveHour}
          limit={limit5h}
          pct={pct5h}
        />
        <WindowCard
          title="This week"
          subtitle="ISO week (Mon–Sun UTC)"
          window={weekly}
          limit={limitWk}
          pct={pctWk}
        />
      </section>

      <section>
        <UsageSparkline />
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Per-agent rollup</h2>
        <UsageSection />
      </section>
    </div>
  );
}

function WindowCard({
  title,
  subtitle,
  window: w,
  limit,
  pct,
}: {
  title: string;
  subtitle: string;
  window: { startTime: Date | string; endTime: Date | string; costUSD: number; totalTokens: number; isActive: boolean } | undefined;
  limit: number | null;
  pct: number | null;
}) {
  if (!w) {
    return (
      <Card className="p-5 space-y-3">
        <div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
        <Skeleton className="h-28" />
      </Card>
    );
  }
  const elapsed = windowElapsed(w.startTime, w.endTime);
  const costPctClamped = pct != null ? Math.min(100, pct) : null;
  return (
    <Card className="p-5 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
        {!w.isActive && (
          <span className="text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded bg-amber-500/10 ring-1 ring-amber-500/30">
            inactive
          </span>
        )}
      </div>

      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="font-mono leading-none text-4xl sm:text-5xl tracking-tight tabular-nums">
          {fmtUSD(w.costUSD)}
        </div>
        {limit != null && costPctClamped != null ? (
          <div className="font-mono text-xs text-muted-foreground space-y-0.5 text-right">
            <div>of {fmtUSD(limit)} budget</div>
            <div className={`text-sm font-medium ${pctTextColor(costPctClamped)}`}>{costPctClamped.toFixed(0)}%</div>
          </div>
        ) : (
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground max-w-[12rem] text-right leading-snug">
            set a limit above to track % of budget
          </div>
        )}
      </div>

      {limit != null && costPctClamped != null && (
        <AnimatedBar pct={costPctClamped} color={pctBarColor(costPctClamped)} />
      )}

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>{elapsed.hours}h window elapsed</span>
          <span className={`font-mono ${pctTextColor(elapsed.pct)}`}>{elapsed.pct.toFixed(0)}%</span>
        </div>
        <AnimatedBar pct={elapsed.pct} color={pctBarColor(elapsed.pct)} />
        <div className="flex items-baseline justify-between text-[10px] font-mono text-muted-foreground/80">
          <span>{new Date(w.startTime).toLocaleString()}</span>
          <span>{new Date(w.endTime).toLocaleString()}</span>
        </div>
      </div>

      <div className="text-[10px] font-mono text-muted-foreground">
        {w.totalTokens.toLocaleString()} tokens
      </div>
    </Card>
  );
}
