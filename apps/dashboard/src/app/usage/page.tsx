'use client';

import { useEffect, useState } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { UsageSection } from '@/components/usage-section';
import { UsageSparkline } from '@/components/usage-sparkline';
import { SettingsTabs } from '@/components/settings-tabs';
import { codexWindowSlots, type CodexUsageSlot } from '@/lib/codex-usage';
import { parseResetText, untilText, formatShanghai, crossesDay, DISPLAY_TZ_LABEL } from '@/lib/reset-time';
import type { AppRouter } from '@/server/routers/_app';

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
        className={`h-full rounded-full ${color} transition-[width,background-color] duration-[900ms] ease-out`}
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
  const kimi = trpc.usage.kimiUsage.useQuery(undefined, { refetchInterval: 2 * 60_000 });
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

          {/* Same rule as Codex: only on a machine that actually holds a Kimi
              credential. The gateway leaves the row absent otherwise. */}
          {kimi.data && <KimiPlan data={kimi.data} now={now} />}

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


// ── Kimi Code ────────────────────────────────────────────────────────────────
//
// Kimi answers the quota question directly (Moonshot's own /v1/usages), so this
// is a real reading like the Claude panel, not a ccusage estimate.
//
// Two clocks, and they are NOT the same fact — showing only one would be a lie
// on whichever day the other bit:
//
//   · the 7-day subscription quota, which refreshes on the subscription date
//     and does not roll over;
//   · a rolling rate window (5 hours today). Quota left over does not stop a
//     429 here, which is exactly the confusion this panel exists to remove.
//
// `used` and `limit` are the vendor's own units — the docs never name them, and
// the Kimi CLI renders the RATIO. So do we: a percentage is the one reading
// that stays true whatever the units turn out to be.
//
// No dollar figure. These turns bill against a membership, and the CLI's own
// cost field is computed from Anthropic's price list, so it is a number nobody
// is charged.

type KimiWindowRow = { minutes: number | null; used: number | null; limit: number | null; resetsAt: string | null };

/**
 * "Rate window (5h)". Named rather than reusing windowLabel(): that one
 * answers "plan usage" for an unknown period, which is the right answer for
 * Codex's single window and a wrong one here, where the SUBSCRIPTION row above
 * is the plan and this row is the thing that 429s you despite it.
 */
function kimiWindowLabel(minutes: number | null): string {
  if (!minutes || minutes <= 0) return 'Rate window';
  if (minutes % 1440 === 0) return `Rate window (${minutes / 1440}d)`;
  if (minutes % 60 === 0) return `Rate window (${minutes / 60}h)`;
  return `Rate window (${minutes}m)`;
}

/** used/limit as a percentage, or null when the pair cannot say. */
function ratioPct(used: number | null | undefined, limit: number | null | undefined): number | null {
  if (used == null || !limit || limit <= 0) return null;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

function KimiRow({
  label, used, limit, resetsAt, now,
}: {
  label: string;
  used: number | null;
  limit: number | null;
  resetsAt: Date | string | null;
  now: Date;
}) {
  const pct = ratioPct(used, limit);
  const at = resetsAt ? new Date(resetsAt) : null;
  const left = at && !Number.isNaN(at.getTime()) ? untilText(at, now) : '';
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className={cn('text-lg font-semibold tabular-nums', pctTextColor(pct ?? 0))}>
          {pct == null ? '—' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}
        </span>
      </div>
      <AnimatedBar pct={pct ?? 0} color={pctBarColor(pct ?? 0)} />
      <div className="text-[11px] text-muted-foreground min-h-[14px]">
        {at && !Number.isNaN(at.getTime()) ? (
          <>
            resets <span className="tabular-nums text-foreground/70">{formatShanghai(at, { withDate: true })}</span>{' '}
            {DISPLAY_TZ_LABEL}
            {left && <> · in <span className="tabular-nums text-foreground/70">{left}</span></>}
          </>
        ) : (
          'no reset reported'
        )}
      </div>
    </div>
  );
}

function KimiPlan({
  data,
  now,
}: {
  data: {
    credentialId: string | null; planLevel: string | null; planName: string | null;
    periodUsed: number | null; periodLimit: number | null; periodResetsAt: Date | string | null;
    windows: unknown; parallelLimit: number | null;
    extraBalanceCents: number | null; extraCurrency: string | null;
    capturedAt: Date | string;
  };
  now: Date;
}) {
  const windows = (Array.isArray(data.windows) ? data.windows : []) as KimiWindowRow[];
  // LEVEL_ADVANCED reads as noise in a heading; the membership's own name wins
  // when the endpoint supplies one.
  const tier = data.planName ?? data.planLevel?.replace(/^LEVEL_/, '').toLowerCase() ?? null;

  return (
    <section className="pt-4">
      <div className="flex items-baseline justify-between mb-2 gap-2">
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground">
          Kimi Code{tier && <span className="ml-1.5 normal-case text-muted-foreground/70">· {tier}</span>}
        </h2>
        <span className="text-[10px] text-muted-foreground/70">
          from <code className="font-mono">/v1/usages</code> · {relTime(data.capturedAt)}
        </span>
      </div>
      <Card className="p-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <KimiRow
            label="Subscription quota (7d)"
            used={data.periodUsed}
            limit={data.periodLimit}
            resetsAt={data.periodResetsAt}
            now={now}
          />
          {windows.map((w, i) => (
            <KimiRow
              key={`${w.minutes ?? 'window'}-${i}`}
              label={kimiWindowLabel(w.minutes)}
              used={w.used}
              limit={w.limit}
              resetsAt={w.resetsAt}
              now={now}
            />
          ))}
        </div>
        {/* The third number that makes a 429 explicable, and the wallet that
            keeps requests flowing once the quota is gone. Both omitted when the
            endpoint says nothing about them. */}
        {(data.parallelLimit != null || data.extraBalanceCents != null) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground border-t pt-3">
            {data.parallelLimit != null && (
              <span>
                concurrency <span className="tabular-nums text-foreground/70">{data.parallelLimit}</span>
              </span>
            )}
            {data.extraBalanceCents != null && (
              <span>
                Extra Usage{' '}
                <span className="tabular-nums text-foreground/70">
                  {(data.extraBalanceCents / 100).toFixed(2)} {data.extraCurrency ?? 'USD'}
                </span>{' '}
                left
              </span>
            )}
            {data.credentialId && <span className="ml-auto font-mono opacity-60">{data.credentialId}</span>}
          </div>
        )}
      </Card>
    </section>
  );
}


// ── Codex ────────────────────────────────────────────────────────────────────
//
// Codex reports server-side percentages with epoch resets. App-server supplies
// every metered bucket at once; the gateway records the source ID for each slot
// and this panel mirrors Claude's two-card layout above.
//
// No dollar figure anywhere. These turns bill against a ChatGPT plan, and a
// computed cost would be a number nobody is charged — the same reason the
// runtime reports costUsd: null.

type CodexUsageData = NonNullable<inferRouterOutputs<AppRouter>['usage']['codexUsage']>;

function CodexBar({ label, window: reading, now }: { label: string; window: CodexUsageSlot | null; now: Date }) {
  const pct = reading?.usedPercent ?? null;
  const at = reading?.resetsAt ? new Date(reading.resetsAt) : null;
  const validAt = at && !Number.isNaN(at.getTime()) ? at : null;
  const left = validAt ? untilText(validAt, now) : '';
  const source = reading?.limitName ?? (reading?.limitId && reading.limitId !== 'codex' ? reading.limitId : null);

  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className={cn('text-lg font-semibold tabular-nums', pctTextColor(pct ?? 0))}>
          {pct == null ? '—' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}
        </span>
      </div>
      <AnimatedBar pct={pct ?? 0} color={pctBarColor(pct ?? 0)} />
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground min-h-[14px]">
        <span className="truncate">
          {validAt ? (
            <>
              resets <span className="tabular-nums text-foreground/70">{formatShanghai(validAt, { withDate: true })}</span>{' '}
              {DISPLAY_TZ_LABEL}
              {left && <> · in <span className="tabular-nums text-foreground/70">{left}</span></>}
            </>
          ) : (
            'no reset reported'
          )}
        </span>
        {source && <span className="shrink-0 truncate max-w-[45%]" title={source}>{source}</span>}
      </div>
    </Card>
  );
}

function CodexPlan({
  data,
  now,
}: {
  data: CodexUsageData;
  now: Date;
}) {
  const { fiveHour, weekly } = codexWindowSlots(data);

  return (
    <section className="pt-4">
      <div className="flex items-baseline justify-between mb-2 gap-2">
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground">
          Codex{data.planType && <span className="ml-1.5 normal-case text-muted-foreground/70">· {data.planType}</span>}
        </h2>
        <span className="text-[10px] text-muted-foreground/70">read {relTime(data.capturedAt)}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <CodexBar label="Session (5h)" window={fiveHour} now={now} />
        <CodexBar label="Weekly" window={weekly} now={now} />
      </div>
    </section>
  );
}
