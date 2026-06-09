'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { UsageSection } from '@/components/usage-section';
import { UsageSparkline } from '@/components/usage-sparkline';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { SettingsTabs } from '@/components/settings-tabs';

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
  // Gateway pushes UsageWindow every 30 min; polling here at 5 min is "fresh
  // enough" without burning DB reads. We also refetch on window-focus by
  // default (tRPC's standard react-query behaviour) so coming back to the tab
  // after a long break shows current data without waiting.
  const windows = trpc.usage.windows.useQuery(undefined, { refetchInterval: 5 * 60_000 });
  // The accurate one — real Claude Max plan % scraped from `claude /usage`.
  const plan = trpc.usage.planUsage.useQuery(undefined, { refetchInterval: 2 * 60_000 });

  const fiveHour = windows.data?.find((w) => w.kind === 'fiveHour');
  const weekly = windows.data?.find((w) => w.kind === 'weekly');

  const limit5h = me.data?.fiveHourLimitUsd ?? null;
  const limitWk = me.data?.weeklyLimitUsd ?? null;
  const pct5h = fiveHour && limit5h ? (fiveHour.costUSD / limit5h) * 100 : null;
  const pctWk = weekly && limitWk ? (weekly.costUSD / limitWk) * 100 : null;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="usage" />
      <div className="lg:hidden px-3 py-2 shrink-0">
        <SidebarMobileToggle />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-6">
          {/* The accurate view — real Claude Max plan % scraped from `claude /usage`. */}
          <section>
            <div className="flex items-baseline justify-between mb-2 gap-2">
              <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Claude Max plan usage</h2>
              <span className="text-[10px] text-muted-foreground/70">
                from <code className="font-mono">claude /usage</code>
                {plan.data?.capturedAt ? ` · ${relTime(plan.data.capturedAt)}` : ''}
              </span>
            </div>
            {plan.isPending ? (
              <Skeleton className="h-24" />
            ) : !plan.data ? (
              <Card className="p-4 text-xs text-muted-foreground">
                No plan-usage reading yet — the gateway scrapes <code className="font-mono">claude /usage</code> every ~12 min.
              </Card>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <PlanBar label="Session (5h)" pct={plan.data.sessionPct} reset={plan.data.sessionResetText} />
                <PlanBar
                  label="Weekly"
                  pct={plan.data.weekPct}
                  reset={plan.data.weekResetText}
                  sub={plan.data.weekSonnetPct != null ? `Sonnet ${plan.data.weekSonnetPct}%` : null}
                />
              </div>
            )}
          </section>

          <p className="text-xs text-muted-foreground pt-2">
            Below: <span className="text-foreground/70">estimated cost</span> from ccusage (token counts × API list price) — a rough
            activity gauge, <span className="text-foreground/70">not</span> your plan limit. Pushed by the Mac gateway ~every 30 min.
          </p>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <WindowCard
          title="5h cost (est.)"
          subtitle="ccusage estimate · rolling 5h block"
          window={fiveHour}
          limit={limit5h}
          pct={pct5h}
        />
        <WindowCard
          title="Weekly cost (est.)"
          subtitle="ccusage estimate · ISO week (Mon–Sun UTC)"
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
      </div>
    </div>
  );
}

// Real Claude Max plan window — the % is authoritative (from `claude /usage`),
// no dollar limit guessing involved.
function PlanBar({ label, pct, reset, sub }: { label: string; pct: number | null; reset: string | null; sub?: string | null }) {
  const p = pct ?? 0;
  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className={cn('text-lg font-semibold tabular-nums', pctTextColor(p))}>
          {pct == null ? '—' : `${pct}%`}
        </span>
      </div>
      <AnimatedBar pct={p} color={pctBarColor(p)} />
      <div className="flex items-center justify-between text-[11px] text-muted-foreground min-h-[14px]">
        <span>{reset ? `resets ${reset}` : ''}</span>
        {sub && <span className="tabular-nums">{sub}</span>}
      </div>
    </Card>
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

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>{elapsed.hours}h window elapsed</span>
          <span className={`font-mono ${pctTextColor(elapsed.pct)}`}>{elapsed.pct.toFixed(0)}%</span>
        </div>
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
