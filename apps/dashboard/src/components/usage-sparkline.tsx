'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { fmtBytes } from '@/lib/format';

// Cost — or tokens, via the switch — per day, one bar per UTC day.
//
// It was 48 bars, one per hour, and it could not work: `ccusage session` dates a
// session by `lastActivity`, which is a DATE, so every row the collector writes lands
// at 00:00 UTC. Only two of the 48 columns could ever hold anything — a midnight spike
// per day with 46 empty slots between them — and the "peak" it printed was a whole
// day's spend wearing an hour's label. The same data drawn at the resolution it has is
// a trend you can actually read.
//
// The dollars are cost with the cache READS priced out. Cache reads are ~98% of the
// tokens and most of the money, and they measure how big the context is, not how much
// work happened — a long conversation re-reads the same context on every turn whether
// it achieves anything or not. What's left moves with output and new input, which is
// the thing a daily trend is for. (The 5h/weekly cards above still show the full
// estimate; they're answering "what did this window cost", not "how busy was I".)
//
// The $/tok switch draws the same bars in the other unit. Both sides exclude cache
// reads — a "tokens" view that included them would be the context-size chart this card
// deliberately isn't (14 days here: 257M without, 10.64B with). Tokens are the same
// quantity the dollars are derived from, minus ccusage's price table, so the shape
// barely moves; what it buys you is a number that doesn't silently change meaning when
// list prices do. The cache-read total still shows in the tooltip, where it reads as
// context weight rather than as the headline.
//
// Days are UTC days, because that is what the buckets ARE. Rendering them in Shanghai
// (as the cost cards do with their own real timestamps) would shift each bar 8 hours
// and file it under the wrong date.

const DAYS = 14;

type Metric = 'cost' | 'tokens';

function $(n: number) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

/** The selected metric, formatted in its own unit. */
function fmtMetric(metric: Metric, n: number) {
  return metric === 'cost' ? $(n) : `${fmtBytes(n)} tok`;
}

/**
 * Small segmented switch for the unit. Deliberately quiet: it sits above a number that
 * is the point of the card, and a loud control there would read as the point instead.
 */
function MetricToggle({ metric, onChange }: { metric: Metric; onChange: (m: Metric) => void }) {
  return (
    <div
      role="group"
      aria-label="Chart unit"
      className="inline-flex items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {(['cost', 'tokens'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={metric === m}
          className={`rounded-[4px] px-1.5 py-0.5 font-mono text-[10px] leading-none transition-colors ${
            metric === m
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {m === 'cost' ? '$' : 'tok'}
        </button>
      ))}
    </div>
  );
}

/** "Aug 3", from the bucket's UTC parts — never the viewer's local date. */
function dayLabel(d: Date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(d);
}

type Bucket = { day: Date; cost: number; tokens: number; cacheRead: number };

/** The bar height, headline and peak all read a bucket through here. */
function metricValue(b: Bucket, metric: Metric) {
  return metric === 'cost' ? b.cost : b.tokens;
}

export function UsageSparkline() {
  const q = trpc.usage.byDay.useQuery({ days: DAYS }, { refetchInterval: 5 * 60_000 });
  const [metric, setMetric] = useState<Metric>('cost');
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, []);

  const buckets = useMemo<Bucket[]>(() => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const out: Bucket[] = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const t = new Date(today);
      t.setUTCDate(t.getUTCDate() - i);
      out.push({ day: t, cost: 0, tokens: 0, cacheRead: 0 });
    }
    if (q.data) {
      const idxByTs = new Map<number, number>();
      out.forEach((b, i) => idxByTs.set(b.day.getTime(), i));
      for (const row of q.data) {
        // Rows are per agent per day; this chart is the whole machine, so they add up.
        const idx = idxByTs.get(new Date(row.day).getTime());
        if (idx != null) {
          out[idx].cost += row.costExCacheRead;
          out[idx].tokens += row.tokensExCacheRead;
          out[idx].cacheRead += row.cacheReadTokens;
        }
      }
    }
    return out;
  }, [q.data]);

  const total = useMemo(
    () => buckets.reduce((acc, b) => acc + metricValue(b, metric), 0),
    [buckets, metric]
  );
  // A floor keeps an all-zero machine (a gateway that never pushed) from dividing by
  // zero; it has to scale with the unit, since 0.01 tokens is not a thing.
  const max = useMemo(
    () => Math.max(metric === 'cost' ? 0.01 : 1, ...buckets.map((b) => metricValue(b, metric))),
    [buckets, metric]
  );
  const peakIdx = useMemo(
    () => buckets.reduce((mi, b, i) => (metricValue(b, metric) > metricValue(buckets[mi], metric) ? i : mi), 0),
    [buckets, metric]
  );

  if (q.isPending) {
    return <Skeleton className="h-44" />;
  }

  return (
    <Card className="p-5 space-y-4 overflow-visible">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">
            {metric === 'cost' ? 'Cost' : 'Tokens'} by day, cache reads excluded
          </div>
          <div className="text-xs text-muted-foreground">
            Last {DAYS} UTC days · all agents on this machine
          </div>
          {/* The spike a long conversation leaves on the day it ended is the single
              most confusing thing on this card — same caveat the per-agent table
              carries, said here too because this is what you look at first. */}
          <div className="text-[11px] text-muted-foreground/70">
            A session lands whole on the day it was <em>last</em> active, not spread over the days it ran.
          </div>
        </div>
        <div className="text-right space-y-1">
          <div className="flex justify-end">
            <MetricToggle metric={metric} onChange={setMetric} />
          </div>
          <div className="font-mono text-2xl tabular-nums tracking-tight leading-none">
            {fmtMetric(metric, total)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {DAYS}d · busiest day {fmtMetric(metric, metricValue(buckets[peakIdx], metric))}
          </div>
        </div>
      </div>

      <div className="flex items-end gap-[3px] h-[110px] pt-2">
        {buckets.map((b, i) => {
          const v = metricValue(b, metric);
          const targetH = max > 0 ? (v / max) * 100 : 0;
          const renderH = mounted ? (v > 0 ? Math.max(6, targetH) : 3) : 3;
          const isToday = i === buckets.length - 1;
          const isPeak = i === peakIdx && v > 0;
          const tooltipAnchor =
            i < 3 ? 'left-0 translate-x-0' : i > buckets.length - 4 ? 'right-0 translate-x-0' : 'left-1/2 -translate-x-1/2';
          return (
            <div key={i} className="flex-1 group relative flex items-end h-full min-w-0">
              <div
                className={`w-full rounded-sm transition-[height,background-color] duration-[700ms] ease-out ${
                  v === 0
                    ? 'bg-foreground/5'
                    : isToday
                      ? 'bg-emerald-500 ring-1 ring-emerald-400/60'
                      : isPeak
                        ? 'bg-emerald-500'
                        : 'bg-emerald-500/60 group-hover:bg-emerald-500'
                }`}
                style={{ height: `${renderH}%` }}
              />
              <div
                className={`pointer-events-none absolute top-0 ${tooltipAnchor} -translate-y-full -mt-2 hidden group-hover:block whitespace-nowrap rounded-md bg-foreground text-background text-[10px] font-mono px-2 py-1 z-20 shadow-md`}
              >
                <div>
                  {dayLabel(b.day)}
                  {isToday ? ' · so far' : ''}
                </div>
                {/* Both units on every hover, whichever one the bars are drawn in —
                    the switch changes what you compare, not what you can read. */}
                <div className="opacity-70">
                  {$(b.cost)} · {fmtBytes(b.tokens)} tok
                </div>
                {/* The 98% that neither number counts, kept where it belongs: a note on
                    how heavy the day's contexts were, not the headline. */}
                {b.cacheRead > 0 && (
                  <div className="opacity-50">+{fmtBytes(b.cacheRead)} cache read</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-between text-[10px] font-mono text-muted-foreground/80 pt-0.5">
        <span>{dayLabel(buckets[0].day)}</span>
        <span className="text-muted-foreground">{dayLabel(buckets[Math.floor((DAYS - 1) / 2)].day)}</span>
        <span>today</span>
      </div>
    </Card>
  );
}
