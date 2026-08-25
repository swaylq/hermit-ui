'use client';

// Cron rendering shared between the /cron detail page and the chat pane's
// schedule cards (loop-bar): the status badge, the expandable run row (lazy
// output + read marking), and the duration/interval formatters. Extracted
// verbatim from app/cron/page.tsx so the two surfaces can't drift — a run has
// to look and behave the same whether you read it in /cron or above the
// composer of the chat it reports into.

import { memo, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Markdown } from '@/components/markdown';
import { cronStatusTone, CRON_STATUS, type CronStatusTone } from '@/lib/cron-status';

// ── format helpers ───────────────────────────────────────────────────────────
export function fmtDur(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}
export function fmtEvery(sec: number): string {
  return `every ${fmtDur(sec)}`;
}
export function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Whether a cron is due — nextFire at/just-before now. True for the ≤15s window
// after "Run now" (runNow sets nextFire=now) and for any overdue job; drives the
// "starting soon…" label so the UI never shows a stale/past timestamp. A
// module-level helper (like relTime) rather than inline in a component: the
// callers' renders stay pure per react-hooks/purity, and the two surfaces share
// one definition of "due".
export function cronDue(nextFire: string | Date | null | undefined): boolean {
  return nextFire != null && new Date(nextFire).getTime() <= Date.now();
}

// tone → badge classes (this site's own visual map; the status→tone grouping is shared).
const CRON_BADGE_CLS: Record<CronStatusTone, string> = {
  ok: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/25',
  bad: 'text-rose-500 bg-rose-500/10 border-rose-500/25',
  inconclusive: 'text-amber-500 bg-amber-500/10 border-amber-500/25',
  neutral: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/25',
};

// `done` is deliberately NOT a CRON_STATUS value: those describe how one RUN
// ended, and this describes the cron itself — a task that iterated toward a goal,
// reached it, printed CRON_DONE and stopped (see the Cron model's doneAt). It
// outranks `off` in the badge because both are `enabled: false` and only one of
// them means somebody switched it off. Green, because reaching the goal is the
// good ending.
export function CronStatusBadge({ status, enabled, done }: { status?: string | null; enabled: boolean; done?: boolean }) {
  const text = done ? 'done' : enabled ? (status ?? 'idle') : 'off';
  const cls = done
    ? CRON_BADGE_CLS.ok
    : enabled
      ? CRON_BADGE_CLS[cronStatusTone(status)]
      : CRON_BADGE_CLS.neutral;
  return (
    <span className={cn('inline-flex items-center rounded border px-1.5 py-px text-[10px] font-mono uppercase tracking-wide', cls, status === CRON_STATUS.running && enabled && 'animate-pulse')}>
      {text}
    </span>
  );
}

// memo'd so a 5s cron.get poll doesn't re-render every run row — React Query's
// structural sharing keeps unchanged run objects referentially stable, `autoOpen`
// is a primitive, and `onRead` is a stable useCallback (see the callers'
// `markRead`), so untouched rows bail. `onRead` takes the runId (the row calls it
// with its own run.id) so the parent can share one stable callback across all rows.
export const CronRunRow = memo(function CronRunRow({
  run,
  onRead,
  autoOpen = false,
}: {
  run: { id: string; firedAt: Date | string; status: string; durationMs: number | null; readAt: Date | string | null };
  onRead: (runId: string) => void;
  autoOpen?: boolean;
}) {
  // Unread = finished run not yet expanded. A transparent dot keeps the row
  // height/alignment identical whether read or unread.
  const unread = !run.readAt && run.status !== 'running';
  // Output is lazy — fetched only when this row is expanded (kept out of cron.get's
  // 5s-polled payload). staleTime keeps it cached so re-expanding doesn't refetch.
  const [open, setOpen] = useState(autoOpen);
  const out = trpc.cron.runOutput.useQuery({ runId: run.id }, { enabled: open, staleTime: 60_000 });
  const ref = useRef<HTMLDetailsElement>(null);
  // Deep-linked from a notification (?run=…): open the row, mark it read, and
  // scroll it into view. Fires once for the targeted row.
  useEffect(() => {
    if (!autoOpen) return;
    if (unread) onRead(run.id);
    ref.current?.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen]);
  return (
    <li>
      <details
        ref={ref}
        open={open}
        className="group rounded-md border border-border"
        onToggle={(e) => { const o = e.currentTarget.open; setOpen(o); if (o && unread) onRead(run.id); }}
      >
        <summary className="cursor-pointer list-none flex items-center gap-2 px-2.5 h-9 text-[12px]">
          <span
            className={cn('h-1.5 w-1.5 rounded-full shrink-0', unread ? 'bg-rose-500' : 'bg-transparent')}
            aria-hidden="true"
            title={unread ? 'unread' : undefined}
          />
          <CronStatusBadge status={run.status} enabled />
          <span className="tabular-nums text-muted-foreground">{relTime(run.firedAt)}</span>
          {run.durationMs != null && <span className="tabular-nums text-muted-foreground/60">{fmtMs(run.durationMs)}</span>}
          <ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="border-t border-border px-3 py-2">
          {!open ? null : out.isPending ? (
            <p className="text-xs text-muted-foreground">loading…</p>
          ) : out.data?.output ? (
            <div className="max-h-72 overflow-auto text-[12px] text-foreground/85">
              <Markdown>{out.data.output}</Markdown>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{run.status === 'running' ? 'running…' : 'no output captured'}</p>
          )}
        </div>
      </details>
    </li>
  );
});
