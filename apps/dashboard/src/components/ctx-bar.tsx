'use client';

import { ctxPct, fmtBytes } from '@/lib/format';

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-rose-500';
  if (pct >= 70) return 'bg-amber-400';
  return 'bg-emerald-500';
}

function textColor(pct: number): string {
  if (pct >= 90) return 'text-rose-400';
  if (pct >= 70) return 'text-amber-400';
  return 'text-emerald-400';
}

/**
 * Inline context-usage indicator: token count + thin progress bar + percent.
 * Designed to drop into a flex row of small mono text without breaking baseline.
 * Inherits font-size / family from the parent so it can be used inside the
 * chat header or any 10-12px caption strip.
 *
 * ALWAYS renders — even when `tokens` is null (no completed turn yet) it shows a
 * muted `ctx —` so the percentage is present in every session state, per the
 * "ctx 占比任何状态都要显示" requirement. `variant="compact"` drops the token
 * count + bar and shows just `ctx NN%` for tight rows (the sidebar).
 */
export function CtxBar({
  tokens,
  total = 1_000_000,
  showLabel = true,
  variant = 'full',
}: {
  tokens: number | null | undefined;
  total?: number;
  showLabel?: boolean;
  variant?: 'full' | 'compact';
}) {
  const known = tokens != null;
  const pct = known ? ctxPct(tokens, total) : 0;
  const fill = known ? Math.max(2, Math.min(100, pct)) : 0;
  const pctText = known ? `${pct.toFixed(0)}%` : '—';
  const pctClass = known ? textColor(pct) : 'text-muted-foreground/50';
  const title = known
    ? `context ${tokens!.toLocaleString()} / ${total.toLocaleString()} tokens (${pct.toFixed(1)}%)`
    : 'context usage unknown — no completed turn yet';

  if (variant === 'compact') {
    return (
      <span className="inline-flex items-center gap-1" title={title}>
        {showLabel && <span className="text-muted-foreground/70">ctx</span>}
        <span className={`tabular-nums ${pctClass}`}>{pctText}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      {showLabel && <span className="text-muted-foreground/70">ctx</span>}
      <span className="tabular-nums text-foreground">{known ? fmtBytes(tokens!) : '—'}</span>
      <span
        className="relative h-[4px] w-14 overflow-hidden rounded-full bg-foreground/10 ring-1 ring-foreground/5"
        aria-hidden="true"
      >
        <span
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out ${barColor(pct)}`}
          style={{ width: `${fill}%` }}
        />
      </span>
      <span className={`tabular-nums ${pctClass}`}>{pctText}</span>
    </span>
  );
}
