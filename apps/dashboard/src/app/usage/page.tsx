'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { UsageSection } from '@/components/usage-section';
import { UsageSparkline } from '@/components/usage-sparkline';
import { SettingsTabs } from '@/components/settings-tabs';
import { parseResetText, untilText, formatShanghai, crossesDay, DISPLAY_TZ_LABEL } from '@/lib/reset-time';

function fmtUSD(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
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

/**
 * A clock for the countdowns. Every "resets in …" on this page is derived from it, so
 * one timer keeps them all honest — without it they'd only move when a query polled
 * (2–5 min) and could sit a whole minute stale.
 */
function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
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
  // Gateway pushes UsageWindow every 30 min; polling here at 5 min is "fresh
  // enough" without burning DB reads. We also refetch on window-focus by
  // default (tRPC's standard react-query behaviour) so coming back to the tab
  // after a long break shows current data without waiting.
  const windows = trpc.usage.windows.useQuery(undefined, { refetchInterval: 5 * 60_000 });
  // The accurate one — real Claude Max plan % scraped from `claude /usage`.
  const plan = trpc.usage.planUsage.useQuery(undefined, { refetchInterval: 2 * 60_000 });
  const codex = trpc.usage.codexUsage.useQuery(undefined, { refetchInterval: 2 * 60_000 });
  const now = useNow();

  const fiveHour = windows.data?.find((w) => w.kind === 'fiveHour');
  const weekly = windows.data?.find((w) => w.kind === 'weekly');

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="usage" />

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
                <PlanBar label="Session (5h)" pct={plan.data.sessionPct} reset={plan.data.sessionResetText} now={now} />
                <PlanBar
                  label="Weekly"
                  pct={plan.data.weekPct}
                  reset={plan.data.weekResetText}
                  now={now}
                  sub={plan.data.weekSonnetPct != null ? `Sonnet ${plan.data.weekSonnetPct}%` : null}
                />
              </div>
            )}
          </section>

          {/* Only when this machine has actually run codex — the query is null
              otherwise, and an empty Codex panel on a Claude-only machine is
              noise rather than information. */}
          {codex.data && <CodexPlan data={codex.data} now={now} />}

          <p className="text-xs text-muted-foreground pt-2">
            Below: <span className="text-foreground/70">estimated cost</span> from ccusage (token counts × API list price) — a rough
            activity gauge, <span className="text-foreground/70">not</span> your plan limit. Pushed by the Mac gateway ~every 30 min.
          </p>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <WindowCard
          title="5h cost (est.)"
          subtitle="ccusage estimate · rolling 5h block"
          window={fiveHour}
          now={now}
        />
        <WindowCard
          title="Weekly cost (est.)"
          subtitle="ccusage estimate · ISO week (Mon–Sun UTC)"
          window={weekly}
          now={now}
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
//
// The reset arrives as whatever the /usage panel drew ("5:20am (Asia/Shanghai)"),
// which is a clock reading in whichever zone the gateway's machine is on and tells
// you nothing about how long you've got. Parsed into an instant it becomes both:
// stated in Shanghai, plus the time left. If the format is one we can't read, the raw
// string still shows — worse than a countdown, better than a blank.
function PlanBar({
  label,
  pct,
  reset,
  now,
  sub,
}: {
  label: string;
  pct: number | null;
  reset: string | null;
  now: Date;
  sub?: string | null;
}) {
  const p = pct ?? 0;
  const at = parseResetText(reset, now);
  const left = at ? untilText(at, now) : '';
  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className={cn('text-lg font-semibold tabular-nums', pctTextColor(p))}>
          {pct == null ? '—' : `${pct}%`}
        </span>
      </div>
      <AnimatedBar pct={p} color={pctBarColor(p)} />
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground min-h-[14px]">
        <span className="truncate">
          {at ? (
            <>
              resets <span className="tabular-nums text-foreground/70">{formatShanghai(at, { withDate: true })}</span>{' '}
              {DISPLAY_TZ_LABEL}
              {left && <> · in <span className="tabular-nums text-foreground/70">{left}</span></>}
            </>
          ) : reset ? (
            `resets ${reset}`
          ) : (
            ''
          )}
        </span>
        {sub && <span className="shrink-0 tabular-nums">{sub}</span>}
      </div>
    </Card>
  );
}

// A ccusage cost window. It carries NO percentage and NO budget: the cost is token
// counts × API list price, which is not what a Max subscription charges, so a "% of
// $X" built on it was a guess wearing a number's clothes. What's left is the estimate
// itself (a fine activity gauge), the window's own clock, and when it rolls over.
function WindowCard({
  title,
  subtitle,
  window: w,
  now,
}: {
  title: string;
  subtitle: string;
  window:
    | {
        startTime: Date | string;
        endTime: Date | string;
        costUSD: number;
        totalTokens: number;
        cacheReadTokens: number;
        isActive: boolean;
      }
    | undefined;
  now: Date;
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
  const left = untilText(w.endTime, now);
  // A 5h block usually starts and ends on the same Shanghai day; a weekly one never
  // does. Show the date only when the two ends disagree about it.
  const withDate = crossesDay(w.startTime, w.endTime);
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
        {/* Once the window is over the countdown has nothing to say, and an empty slot
            reads as a bug — the row is simply the last block ccusage reported. */}
        <div className="text-xs text-muted-foreground text-right leading-snug">
          {left ? (
            <>
              resets in <span className="font-mono font-medium text-foreground/80 tabular-nums">{left}</span>
            </>
          ) : (
            'window ended'
          )}
        </div>
      </div>

      {/* Both ends in Shanghai — the window's own boundaries are UTC-derived, and a
          device-local render meant the same window read differently per device. */}
      <div className="flex items-baseline justify-between text-[10px] font-mono text-muted-foreground/80">
        <span>{formatShanghai(w.startTime, { withDate })}</span>
        <span>
          {formatShanghai(w.endTime, { withDate })} {DISPLAY_TZ_LABEL}
        </span>
      </div>

      {/* The cache-read share is the whole story of that number: it is the SAME
          context re-counted on every turn, and it is ~96% of the total. Without it
          "190M tokens in 5 hours" reads as 190M tokens of new text. Hidden when the
          split is absent — an older gateway, or a row written before it existed. */}
      <div className="text-[10px] font-mono text-muted-foreground">
        {w.totalTokens.toLocaleString()} tokens
        {w.cacheReadTokens > 0 && (
          <span className="text-muted-foreground/70">
            {' · '}
            {Math.round((w.cacheReadTokens / Math.max(1, w.totalTokens)) * 100)}% cache reads
          </span>
        )}
      </div>
    </Card>
  );
}


// ── Codex ────────────────────────────────────────────────────────────────────
//
// Codex reports ONE rate-limit window, not Claude's two, and it reports it as a
// server-side percentage with an epoch reset — so this is a different shape
// from PlanBar rather than a reuse of it. `windowMinutes` is rendered rather
// than assumed: 10080 means the percentage is weekly, and a number with no
// stated period is not a fact anyone can act on.
//
// No dollar figure anywhere. These turns bill against a ChatGPT plan, and a
// computed cost would be a number nobody is charged — the same reason the
// runtime reports costUsd: null.

function windowLabel(minutes: number | null | undefined): string {
  if (!minutes) return 'plan usage';
  if (minutes % 10080 === 0) {
    const w = minutes / 10080;
    return w === 1 ? 'weekly' : `${w}-week window`;
  }
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1 ? 'daily' : `${d}-day window`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

type CodexDaily = { day: string; inputTokens: number; outputTokens: number; sessions: number };

function CodexPlan({
  data,
  now,
}: {
  data: { usedPercent: number | null; windowMinutes: number | null; resetsAt: Date | string | null; planType: string | null; daily: unknown; capturedAt: Date | string };
  now: Date;
}) {
  const pct = data.usedPercent ?? null;
  const at = data.resetsAt ? new Date(data.resetsAt) : null;
  const left = at ? untilText(at, now) : '';
  const daily = (Array.isArray(data.daily) ? data.daily : []) as CodexDaily[];
  const peak = Math.max(1, ...daily.map((d) => d.inputTokens + d.outputTokens));
  const totalIn = daily.reduce((a, d) => a + d.inputTokens, 0);
  const totalOut = daily.reduce((a, d) => a + d.outputTokens, 0);

  return (
    <section className="pt-4">
      <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
        Codex{data.planType && <span className="ml-1.5 normal-case text-muted-foreground/70">· {data.planType}</span>}
      </h2>
      <Card className="p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium text-foreground">{windowLabel(data.windowMinutes)}</span>
          <span className={cn('text-lg font-semibold tabular-nums', pctTextColor(pct ?? 0))}>
            {pct == null ? '—' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}
          </span>
        </div>
        <AnimatedBar pct={pct ?? 0} color={pctBarColor(pct ?? 0)} />
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground min-h-[14px]">
          <span className="truncate">
            {at ? (
              <>
                resets <span className="tabular-nums text-foreground/70">{formatShanghai(at, { withDate: true })}</span>{' '}
                {DISPLAY_TZ_LABEL}
                {left && <> · in <span className="tabular-nums text-foreground/70">{left}</span></>}
              </>
            ) : (
              'no reset reported'
            )}
          </span>
          <span className="shrink-0">read {relTime(data.capturedAt)}</span>
        </div>

        {daily.length > 0 && (
          <>
            <div className="flex items-end gap-1 h-16 pt-1">
              {daily.map((d) => {
                const total = d.inputTokens + d.outputTokens;
                return (
                  <div
                    key={d.day}
                    className="flex-1 min-w-0 bg-foreground/15 hover:bg-foreground/30 rounded-sm transition-colors"
                    style={{ height: `${Math.max(3, (total / peak) * 100)}%` }}
                    title={`${d.day} · ${total.toLocaleString()} tokens · ${d.sessions} session${d.sessions === 1 ? '' : 's'}`}
                  />
                );
              })}
            </div>
            {/* Days codex actually ran, not calendar days — it writes a
                directory only when there was a session, so a gap is a quiet
                day rather than missing data. */}
            <div className="flex items-baseline justify-between text-[10px] font-mono text-muted-foreground/80">
              <span>{daily[0]?.day}</span>
              <span>
                {fmtTokens(totalIn)} in · {fmtTokens(totalOut)} out over {daily.length} active day
                {daily.length === 1 ? '' : 's'}
              </span>
              <span>{daily[daily.length - 1]?.day}</span>
            </div>
          </>
        )}
      </Card>
    </section>
  );
}
