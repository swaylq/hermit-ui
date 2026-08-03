'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { fmtBytes } from '@/lib/format';

// Cost per day, one bar per UTC day.
//
// It was 48 bars, one per hour, and it could not work: `ccusage session` dates a
// session by `lastActivity`, which is a DATE, so every row the collector writes lands
// at 00:00 UTC. Only two of the 48 columns could ever hold anything — a midnight spike
// per day with 46 empty slots between them — and the "peak" it printed was a whole
// day's spend wearing an hour's label. The same data drawn at the resolution it has is
// a trend you can actually read.
//
// Days are UTC days, because that is what the buckets ARE. Rendering them in Shanghai
// (as the cost cards do with their own real timestamps) would shift each bar 8 hours
// and file it under the wrong date.

const DAYS = 14;

function $(n: number) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

/** "Aug 3", from the bucket's UTC parts — never the viewer's local date. */
function dayLabel(d: Date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(d);
}

type Bucket = { day: Date; cost: number; tokens: number };

export function UsageSparkline() {
  const q = trpc.usage.byDay.useQuery({ days: DAYS }, { refetchInterval: 5 * 60_000 });
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
      out.push({ day: t, cost: 0, tokens: 0 });
    }
    if (q.data) {
      const idxByTs = new Map<number, number>();
      out.forEach((b, i) => idxByTs.set(b.day.getTime(), i));
      for (const row of q.data) {
        // Rows are per agent per day; this chart is the whole machine, so they add up.
        const idx = idxByTs.get(new Date(row.day).getTime());
        if (idx != null) {
          out[idx].cost += row.cost;
          out[idx].tokens += row.tokens;
        }
      }
    }
    return out;
  }, [q.data]);

  const total = useMemo(() => buckets.reduce((acc, b) => acc + b.cost, 0), [buckets]);
  const max = useMemo(() => Math.max(0.01, ...buckets.map((b) => b.cost)), [buckets]);
  const peakIdx = useMemo(
    () => buckets.reduce((mi, b, i) => (b.cost > buckets[mi].cost ? i : mi), 0),
    [buckets]
  );

  if (q.isPending) {
    return <Skeleton className="h-44" />;
  }

  return (
    <Card className="p-5 space-y-4 overflow-visible">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">Cost by day</div>
          <div className="text-xs text-muted-foreground">
            Last {DAYS} UTC days · all agents on this machine
          </div>
        </div>
        <div className="text-right space-y-0.5">
          <div className="font-mono text-2xl tabular-nums tracking-tight leading-none">
            {$(total)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {DAYS}d · busiest day {$(buckets[peakIdx].cost)}
          </div>
        </div>
      </div>

      <div className="flex items-end gap-[3px] h-[110px] pt-2">
        {buckets.map((b, i) => {
          const targetH = max > 0 ? (b.cost / max) * 100 : 0;
          const renderH = mounted ? (b.cost > 0 ? Math.max(6, targetH) : 3) : 3;
          const isToday = i === buckets.length - 1;
          const isPeak = i === peakIdx && b.cost > 0;
          const tooltipAnchor =
            i < 3 ? 'left-0 translate-x-0' : i > buckets.length - 4 ? 'right-0 translate-x-0' : 'left-1/2 -translate-x-1/2';
          return (
            <div key={i} className="flex-1 group relative flex items-end h-full min-w-0">
              <div
                className={`w-full rounded-sm transition-[height,background-color] duration-[700ms] ease-out ${
                  b.cost === 0
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
                <div className="opacity-70">
                  {$(b.cost)} · {fmtBytes(b.tokens)} tok
                </div>
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
