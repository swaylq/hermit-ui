'use client';

// The tool-run capsule — one row standing in for every tool call, tool result
// and thinking block between two things a person can read. See fold-runs.ts for
// what gets folded and why.
//
// Collapsed it is a single line: what ran, how many steps, how long, and — while
// the turn is still going — a sweep bar and the tool currently in flight.
// Expanded it is exactly the old timeline: the same ToolChip / InlineToolResult
// components in the same order, so nothing is lost, only deferred.
//
// The body mounts only while open. A session's history holds hundreds of these;
// rendering every hidden `<pre>` (and its JSON.stringify) is the cost this row
// exists to avoid.

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { ToolChip, InlineToolResult, oneLineArg } from '@/components/chat/tool-chips';
import { foldRuns, summarizeRun, type RunStep } from '@/components/chat/fold-runs';

// Fetching the full body of a digested run, when one is expanded. History pages
// arrive digested (tool arguments trimmed to a preview, results to their first
// line) — that is what makes paging back cheap. Opening a capsule is the moment
// the reader actually asks for the rest, and only then does it cost a request.
//
// A context rather than a prop so the resolver can change identity freely
// without breaking memo() on every row between here and SessionPane.
export type RunResolver = (ids: string[]) => Promise<RunStep[] | null>;
export const RunDetailContext = createContext<RunResolver | null>(null);

/** Re-derive a run's steps from freshly-fetched full message rows. */
export function stepsFromRows(rows: Array<{ id: string; role: string; content: unknown; createdAt: Date | string }>): RunStep[] {
  const steps: RunStep[] = [];
  for (const r of foldRuns(rows)) {
    if (r.kind === 'run') steps.push(...r.steps);
  }
  return steps;
}

/** A 1s clock that only runs while `on`. At most one capsule is ever live. */
function useNowTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// The tool names, elided in the middle rather than the tail: the first tool says
// what the run started as and the count says how far it went. Showing eight
// names would just wrap.
function namesLabel(names: string[]): string {
  if (names.length === 0) return 'thinking';
  if (names.length <= 3) return names.join(' · ');
  return `${names.slice(0, 3).join(' · ')} +${names.length - 3}`;
}

export type RunCapsuleProps = {
  ids: string[];
  steps: RunStep[];
  from: Date | string;
  to: Date | string;
  /** This run is the live tail of a turn that is still going. */
  running?: boolean;
  /** Gateway-reported activity, so the label survives a long silent tool call
   *  that emits no new block for minutes. Primitives, not the activity object:
   *  the object is a fresh identity on every 5s poll and would defeat memo(). */
  label?: string | null;
  detail?: string | null;
};

export const RunCapsule = memo(function RunCapsule({ ids, steps, from, to, running = false, label = null, detail = null }: RunCapsuleProps) {
  const [open, setOpen] = useState(false);
  const resolve = useContext(RunDetailContext);
  // Full steps, once fetched. Null until then; the digest is what renders in the
  // meantime, so expanding is never blocked on the network.
  const [full, setFull] = useState<RunStep[] | null>(null);
  const [fetching, setFetching] = useState(false);

  const sum = useMemo(() => summarizeRun(steps), [steps]);
  const shown = full ?? steps;

  const onToggle = useCallback(
    (e: React.SyntheticEvent<HTMLDetailsElement>) => {
      const isOpen = (e.currentTarget as HTMLDetailsElement).open;
      setOpen(isOpen);
      if (!isOpen || full || fetching || !sum.digested || !resolve) return;
      setFetching(true);
      void resolve(ids)
        .then((s) => {
          if (s && s.length > 0) setFull(s);
        })
        .catch(() => {})
        .finally(() => setFetching(false));
    },
    [full, fetching, sum.digested, resolve, ids]
  );

  // While running, the header tracks the live tool. The gateway's own activity
  // snapshot wins when it has one: a Bash that has been going for four minutes
  // emits no new block, so the newest tool_use in this run can be minutes stale
  // while the snapshot is still correct.
  const liveLabel = running ? label ?? sum.last?.name ?? null : null;
  const liveDetail = running ? (detail ?? (sum.last ? oneLineArg(sum.last.input) : '')) || '' : '';

  // Elapsed ticks locally rather than riding the 5s session poll — one timer,
  // only while this capsule is the live tail, and it re-renders nothing above it.
  const now = useNowTick(running);
  const startMs = new Date(from).getTime();
  const endMs = running ? now : new Date(to).getTime();
  const duration = fmtDuration(endMs - startMs);

  // A run with no tool calls is a thinking block on its own — an assistant turn
  // of `[thinking, text]` produces one before every final reply, and a
  // full-width bar for each would be a rule across the conversation every few
  // paragraphs. Same component, same expand, one line of chip instead.
  if (!running && sum.calls === 0 && sum.thinkChars > 0) {
    return (
      <details className="w-fit max-w-full overflow-hidden rounded border border-border/60 bg-background text-[11px]" onToggle={onToggle}>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-0.5 font-mono italic text-muted-foreground/80">
          <span aria-hidden>💭</span>
          <span>thinking</span>
          <span className="tabular-nums text-muted-foreground/60">· {fmtChars(sum.thinkChars)}</span>
        </summary>
        {open && (
          <div className="space-y-1 border-t border-border/60 bg-muted/20 p-1.5 animate-in fade-in-0 duration-150">
            {fetching && <div className="px-1 py-0.5 font-mono text-[10px] not-italic text-muted-foreground">正在取回完整记录…</div>}
            {shown.map((st, i) => (
              <StepView key={i} step={st} />
            ))}
          </div>
        )}
      </details>
    );
  }

  return (
    <details
      // The border stays neutral even when a step failed. A tool error is
      // routine — a grep that matched nothing, a file the agent then created —
      // and a rose outline on every such run would train the eye to ignore it.
      // The count carries the colour instead.
      className="group/run min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-background transition-colors hover:border-foreground/25"
      onToggle={onToggle}
    >
      <summary className="cursor-pointer list-none select-none">
        <div className="flex items-center gap-2 px-2.5 py-1.5 font-mono text-[11px]">
          {running ? (
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full bg-foreground motion-safe:animate-[breathe_1.4s_ease-in-out_infinite]"
            />
          ) : (
            <span aria-hidden className="shrink-0 text-muted-foreground/60 transition-transform group-open/run:rotate-90">
              ▸
            </span>
          )}

          <span className={cn('min-w-0 truncate', running ? 'text-foreground' : 'text-foreground/80')}>
            {running ? liveLabel ?? 'working' : namesLabel(sum.names)}
          </span>
          {(running ? liveDetail : '') && (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{liveDetail}</span>
          )}

          <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums text-muted-foreground/70">
            {sum.errors > 0 && (
              <span className="text-rose-500">
                {sum.errors} error{sum.errors > 1 ? 's' : ''}
              </span>
            )}
            {sum.calls > 0 && <span>{sum.calls} 步</span>}
            {duration && <span>· {duration}</span>}
          </span>
        </div>

        {/* Indeterminate sweep. Only while running, and only when collapsed — an
            open capsule is being read, and a moving bar above the thing you are
            reading is noise. */}
        {running && (
          <div className="h-0.5 w-full overflow-hidden bg-border/70 group-open/run:hidden" aria-hidden>
            <div className="h-full w-1/3 bg-foreground/60 motion-safe:animate-[run-sweep_1.6s_ease-in-out_infinite]" />
          </div>
        )}
      </summary>

      {open && (
        <div className="space-y-1 border-t border-border bg-muted/20 p-1.5 animate-in fade-in-0 duration-150">
          {fetching && <div className="px-1 py-0.5 font-mono text-[10px] text-muted-foreground">正在取回完整记录…</div>}
          {shown.map((s, i) => (
            <StepView key={i} step={s} />
          ))}
        </div>
      )}
    </details>
  );
});

function StepView({ step }: { step: RunStep }) {
  if (step.t === 'call') {
    return (
      <div className="flex">
        <ToolChip call={step.call} dark={false} inline />
      </div>
    );
  }
  if (step.t === 'result') return <InlineToolResult block={step.block} />;
  return (
    <details className="rounded border border-border/60 bg-background px-2 py-1 text-[11px] italic text-muted-foreground">
      <summary className="cursor-pointer list-none">
        💭 thinking{step.chars ? ` · ${step.chars} chars` : ''}
      </summary>
      {step.text ? (
        <p className="mt-1 whitespace-pre-wrap not-italic text-foreground/70">{step.text}</p>
      ) : (
        <p className="mt-1 not-italic text-muted-foreground/70">（内容未随历史下载）</p>
      )}
    </details>
  );
}
