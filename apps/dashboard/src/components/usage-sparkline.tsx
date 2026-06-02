'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { fmtBytes } from '@/lib/format';

function $(n: number) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function hourLabel(d: Date) {
  const m = d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  const h = d.getUTCHours().toString().padStart(2, '0');
  return `${m}, ${h}:00 UTC`;
}

type Bucket = { hour: Date; cost: number; tokens: number };

export function UsageSparkline() {
  const q = trpc.usage.byHour.useQuery({ hours: 48 }, { refetchInterval: 5 * 60_000 });
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, []);

  const buckets = useMemo<Bucket[]>(() => {
    const now = new Date();
    now.setUTCMinutes(0, 0, 0);
    const out: Bucket[] = [];
    for (let i = 47; i >= 0; i--) {
      const t = new Date(now);
      t.setUTCHours(t.getUTCHours() - i);
      out.push({ hour: t, cost: 0, tokens: 0 });
    }
    if (q.data) {
      const idxByTs = new Map<number, number>();
      out.forEach((b, i) => idxByTs.set(b.hour.getTime(), i));
      for (const row of q.data) {
        const idx = idxByTs.get(new Date(row.hour).getTime());
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
          <div className="text-sm font-medium">48-hour cost trend</div>
          <div className="text-xs text-muted-foreground">
            Hourly aggregate · all agents on this machine
          </div>
        </div>
        <div className="text-right space-y-0.5">
          <div className="font-mono text-2xl tabular-nums tracking-tight leading-none">
            {$(total)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            48h · peak {$(buckets[peakIdx].cost)}
          </div>
        </div>
      </div>

      <div className="flex items-end gap-[3px] h-[110px] pt-2">
        {buckets.map((b, i) => {
          const targetH = max > 0 ? (b.cost / max) * 100 : 0;
          const renderH = mounted ? (b.cost > 0 ? Math.max(6, targetH) : 3) : 3;
          const isNow = i === buckets.length - 1;
          const isPeak = i === peakIdx && b.cost > 0;
          const tooltipAnchor =
            i < 8 ? 'left-0 translate-x-0' : i > buckets.length - 9 ? 'right-0 translate-x-0' : 'left-1/2 -translate-x-1/2';
          return (
            <div key={i} className="flex-1 group relative flex items-end h-full min-w-0">
              <div
                className={`w-full rounded-sm transition-[height,background-color] duration-[700ms] ease-out ${
                  b.cost === 0
                    ? 'bg-foreground/5'
                    : isNow
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
                <div>{hourLabel(b.hour)}</div>
                <div className="opacity-70">
                  {$(b.cost)} · {fmtBytes(b.tokens)} tok
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-between text-[10px] font-mono text-muted-foreground/80 pt-0.5">
        <span>{hourLabel(buckets[0].hour)}</span>
        <span className="text-muted-foreground">24h ago</span>
        <span>now</span>
      </div>
    </Card>
  );
}
