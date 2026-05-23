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
 */
export function CtxBar({
  tokens,
  total = 1_000_000,
  showLabel = true,
}: {
  tokens: number | null | undefined;
  total?: number;
  showLabel?: boolean;
}) {
  if (tokens == null) return null;
  const pct = ctxPct(tokens, total);
  const fill = Math.max(2, Math.min(100, pct));
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`context ${tokens.toLocaleString()} / ${total.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
    >
      {showLabel && <span className="text-muted-foreground/70">ctx</span>}
      <span className="tabular-nums text-foreground">{fmtBytes(tokens)}</span>
      <span
        className="relative h-[4px] w-14 overflow-hidden rounded-full bg-foreground/10 ring-1 ring-foreground/5"
        aria-hidden="true"
      >
        <span
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out ${barColor(pct)}`}
          style={{ width: `${fill}%` }}
        />
      </span>
      <span className={`tabular-nums ${textColor(pct)}`}>{pct.toFixed(0)}%</span>
    </span>
  );
}
