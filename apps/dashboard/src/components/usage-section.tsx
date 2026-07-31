'use client';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { relTime } from '@/lib/format';

function $(n: number) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

export function UsageSection() {
  // Gateway pushes UsageHourly every 30 min — DB-backed; 5 min poll keeps
  // freshness within ~quarter of the data cycle without hammering.
  const q = trpc.usage.list.useQuery(undefined, { refetchInterval: 5 * 60_000 });

  if (q.isPending) {
    return <Skeleton className="h-32" />;
  }
  if (!q.data?.rows.length) {
    return (
      <Card className="p-4 text-sm text-muted-foreground">
        no usage data yet — waiting on the gateway&apos;s next 30 min push.
      </Card>
    );
  }

  const totalToday = q.data.rows.reduce((acc, r) => acc + r.today, 0);
  const total30 = q.data.rows.reduce((acc, r) => acc + r.last30d, 0);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">Usage</div>
          <p className="text-xs text-muted-foreground">
            gateway-pushed · last sync {relTime(q.data.fetchedAt)}
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">total · today</div>
          <div className="font-mono">
            {$(totalToday)} <span className="text-muted-foreground">/ 30d {$(total30)}</span>
          </div>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground text-left">
          <tr className="border-b">
            <th className="py-1.5 pl-3 font-normal">agent</th>
            <th className="font-normal">today</th>
            <th className="font-normal">7d</th>
            <th className="font-normal">30d</th>
            <th className="font-normal">all time</th>
            <th className="pr-3 font-normal text-right">sessions</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {q.data.rows.map((r) => (
            <tr key={r.agent} className="border-t">
              <td className="py-1.5 pl-3">{r.agent}</td>
              <td>{$(r.today)}</td>
              <td className="text-muted-foreground">{$(r.last7d)}</td>
              <td className="text-muted-foreground">{$(r.last30d)}</td>
              <td className="text-muted-foreground">{$(r.allTime)}</td>
              <td className="pr-3 text-right text-muted-foreground">{r.sessions}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Say what a column MEANS, because the honest answer isn't "cost on that day".
          ccusage reports a session's lifetime total against its last-activity date, so
          a conversation that ran for a week lands whole on the day it last ran. Each
          session is counted exactly once — that part is now enforced by the writer
          replacing its window rather than adding to it. */}
      <p className="border-t px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        Each session counts once, on the day it was <em>last</em> active — so a conversation that ran all
        week lands whole on its final day. Read the columns as “sessions last used in this window”, not
        “spent that day”.
      </p>
    </Card>
  );
}
