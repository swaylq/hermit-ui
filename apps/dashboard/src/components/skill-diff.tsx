'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

// Line-level diff between two SKILL.md bodies (the marketplace stores full
// content per version, so this runs entirely client-side — no endpoint). Bodies
// are ≤16KB (gateway cap) ⇒ a few hundred lines, so the O(n·m) LCS table is
// tiny; a guard falls back to a coarse whole-block diff for pathological inputs.

type Row = { type: 'add' | 'del' | 'ctx'; text: string };

function diffLines(oldText: string, newText: string): Row[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  // Safety valve: an LCS table for thousands of lines would allocate tens of MB.
  // Real SKILL.md files are hundreds of lines; beyond that, degrade gracefully.
  if (n > 2000 || m > 2000) {
    return [
      ...a.map((text): Row => ({ type: 'del', text })),
      ...b.map((text): Row => ({ type: 'add', text })),
    ];
  }
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: 'del', text: a[i] }); i++; }
    else { rows.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] });
  while (j < m) rows.push({ type: 'add', text: b[j++] });
  return rows;
}

// Collapse runs of unchanged lines >2·CONTEXT into a single marker, keeping
// CONTEXT lines of breathing room on each side of every change.
const CONTEXT = 3;
type Block = Row | { type: 'gap'; count: number };
function collapse(rows: Row[]): Block[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  for (let k = 0; k < rows.length; k++) {
    if (rows[k].type !== 'ctx') {
      for (let d = -CONTEXT; d <= CONTEXT; d++) {
        const idx = k + d;
        if (idx >= 0 && idx < rows.length) keep[idx] = true;
      }
    }
  }
  const out: Block[] = [];
  let run = 0;
  for (let k = 0; k < rows.length; k++) {
    if (rows[k].type === 'ctx' && !keep[k]) { run++; continue; }
    if (run > 0) { out.push({ type: 'gap', count: run }); run = 0; }
    out.push(rows[k]);
  }
  if (run > 0) out.push({ type: 'gap', count: run });
  return out;
}

export function SkillDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const { blocks, adds, dels } = useMemo(() => {
    const rows = diffLines(oldText, newText);
    return {
      blocks: collapse(rows),
      adds: rows.filter((r) => r.type === 'add').length,
      dels: rows.filter((r) => r.type === 'del').length,
    };
  }, [oldText, newText]);

  if (adds === 0 && dels === 0) {
    return <div className="text-xs text-muted-foreground px-1 py-2">两版内容完全相同。</div>;
  }

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-mono">
        <span className="text-emerald-600 dark:text-emerald-400">+{adds}</span>
        <span className="text-rose-600 dark:text-rose-400">−{dels}</span>
        <span className="text-muted-foreground/60">行</span>
      </div>
      <div className="font-mono text-[12px] leading-relaxed">
        {blocks.map((b, k) => {
          if (b.type === 'gap') {
            return (
              <div key={k} className="px-3 py-0.5 text-[10px] text-muted-foreground/50 bg-muted/20 select-none">
                ⋯ {b.count} unchanged ⋯
              </div>
            );
          }
          const tone =
            b.type === 'add' ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
            : b.type === 'del' ? 'bg-rose-500/10 text-rose-800 dark:text-rose-300'
            : 'text-foreground/70';
          const sign = b.type === 'add' ? '+' : b.type === 'del' ? '−' : ' ';
          return (
            <div key={k} className={cn('flex gap-2 px-3 whitespace-pre-wrap break-words', tone)}>
              <span className="select-none shrink-0 w-3 text-right opacity-50">{sign}</span>
              <span className="min-w-0">{b.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
