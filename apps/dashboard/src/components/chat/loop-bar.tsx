'use client';

// The loop/schedule strip above the composer: LoopBar (the strip itself) plus its
// LoopCard / LoopDetail / LoopRuns / LoopRunRow children and the parseLoopRun
// helper. Extracted verbatim from chat/page.tsx (P2-3); behaviour identical. Only
// LoopBar is consumed outside (by SessionPane); the rest stay module-private.

import { useState, useMemo } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Markdown } from '@/components/markdown';
import { msgText } from './lib';

interface LoopEntry {
  id?: string;
  kind?: string;
  schedule?: string;
  prompt?: string;
  status?: string;
  runCount?: number;
  createdAt?: string;
  lastRunAt?: string;
  lastResult?: string;
  // The ChatSession that created this loop (=== gateway's HERMIT_SESSION_ID). A
  // loop is session-scoped, but `.loop-state.json` is agent-dir-level, so without
  // this every sibling session of the agent would render the same loop card.
  ownerSessionId?: string;
}

// Strip above the composer: each active loop as a status card (click to expand
// details), a compact count of any scheduled routines, and a persistent
// "开启循环任务" suggestion that fills the composer with a template. Loop and
// schedule data is the opaque JSON the gateway forwards from
// `<agent_dir>/.loop-state.json` → `session.loopState`.
export function LoopBar({
  loopState,
  onStartLoop,
  onStartCron,
  disabled,
  sessionId,
}: {
  loopState: unknown;
  onStartLoop: () => void;
  onStartCron: () => void;
  disabled?: boolean;
  sessionId: string;
}) {
  const s =
    loopState && typeof loopState === 'object'
      ? (loopState as { loops?: unknown[]; schedules?: unknown[] })
      : null;
  // Loops are session-scoped — a loop rides the one Claude session that created
  // it. `.loop-state.json` is agent-dir-level, so the gateway attaches it to
  // EVERY active session of the agent; filter to this session's own loops so a
  // sibling session doesn't show a loop it doesn't own. Legacy loops written
  // before ownership stamping have no ownerSessionId → still shown everywhere (no
  // regression). Schedules (cron) stay agent-level and are intentionally NOT
  // filtered.
  const allLoops = (s && Array.isArray(s.loops) ? s.loops : []) as LoopEntry[];
  const ownLoops = allLoops.filter((l) => !l.ownerSessionId || l.ownerSessionId === sessionId);

  // Per-loop delete: the gateway removes a stopped loop from `.loop-state.json`
  // (a few seconds via the agent-request tick), so hide it locally right away for
  // instant feedback. Once the gateway's edit lands, the loop is gone from
  // loopState and stays hidden even after this local set resets.
  const deleteLoop = trpc.chat.deleteLoop.useMutation();
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const onDeleteLoop = (id: string) => {
    setDeletedIds((prev) => new Set(prev).add(id));
    deleteLoop.mutate({ sessionId, loopId: id });
  };
  const loops = ownLoops.filter((l) => !(typeof l.id === 'string' && deletedIds.has(l.id)));
  const schedules = (s && Array.isArray(s.schedules) ? s.schedules : []) as Array<{
    id?: string;
    cron?: string;
    prompt?: string;
  }>;

  return (
    <div className="shrink-0 bg-background pt-2">
      {/* Match ComposeBar's container (mx-auto w-full max-w-3xl px-3) exactly so
          the suggestion chip's left edge lines up with the composer box. */}
      <div className="mx-auto w-full max-w-3xl px-3 flex flex-col gap-1.5">
        {loops.map((l, i) => (
          <LoopCard key={typeof l.id === 'string' ? l.id : `loop-${i}`} loop={l} sessionId={sessionId} onDelete={onDeleteLoop} />
        ))}
        <div className="flex items-center gap-2 flex-wrap">
          {!disabled && (
            <button
              type="button"
              onClick={onStartLoop}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer"
            >
              <span className="text-emerald-500" aria-hidden="true">↻</span>
              Start a loop
            </button>
          )}
          {!disabled && (
            <button
              type="button"
              onClick={onStartCron}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer"
            >
              <span className="text-sky-500" aria-hidden="true">⏰</span>
              Schedule a task
            </button>
          )}
          {schedules.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className="text-sky-500" aria-hidden="true">⏰</span>
              <span className="tabular-nums">{schedules.length}</span> scheduled
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// One active loop, collapsed to a status line; click toggles a detail panel.
function LoopCard({ loop, sessionId, onDelete }: { loop: LoopEntry; sessionId: string; onDelete?: (id: string) => void }) {
  const id = typeof loop.id === 'string' ? loop.id : 'loop';
  const status = typeof loop.status === 'string' ? loop.status : 'running';
  const runCount = typeof loop.runCount === 'number' ? loop.runCount : null;
  const schedule = loop.schedule ?? loop.kind ?? 'loop';
  const stopped = status !== 'running';
  // Track expansion so the per-round query only fires once the card is open.
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group rounded-lg border border-border bg-card"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer list-none flex items-center gap-2 px-2.5 h-9 text-[12px]">
        <span
          className={cn('shrink-0', stopped ? 'text-muted-foreground' : 'text-emerald-500')}
          aria-hidden="true"
        >
          {stopped ? '■' : '↻'}
        </span>
        <span className="font-medium text-foreground truncate">{schedule}</span>
        {loop.prompt && (
          <span className="text-muted-foreground truncate hidden sm:inline">· {loop.prompt}</span>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0 text-muted-foreground">
          {runCount != null && <span className="tabular-nums">已跑 {runCount}</span>}
          <span className="text-[10px] uppercase tracking-wide">{status}</span>
          {stopped && onDelete && (
            <button
              type="button"
              aria-label="删除已停止的循环"
              title="删除（从面板移除，不再显示）"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(id);
              }}
              className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          <ChevronDown
            className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>
      {/* Cap the whole expanded panel so a long lastResult / many rounds can't
          grow the shrink-0 LoopBar and squeeze the conversation above it. One
          bounded scroll region (not nested) avoids a scroll-trap on mobile;
          overscroll-contain keeps the scroll from chaining into the chat. */}
      <div className="border-t border-border px-3 py-2 text-[12px] space-y-1 max-h-[40vh] overflow-y-auto overscroll-contain">
        {loop.prompt && <LoopDetail k="任务" v={loop.prompt} />}
        <LoopDetail k="节奏" v={schedule} />
        {loop.kind && <LoopDetail k="类型" v={loop.kind} />}
        {runCount != null && <LoopDetail k="已运行" v={`${runCount} 次`} />}
        {loop.lastRunAt && <LoopDetail k="上次" v={new Date(loop.lastRunAt).toLocaleString()} />}
        {loop.createdAt && <LoopDetail k="开始" v={new Date(loop.createdAt).toLocaleString()} />}
        <LoopRuns
          sessionId={sessionId}
          loopId={id}
          open={open}
          fallback={typeof loop.lastResult === 'string' ? loop.lastResult : null}
        />
        <div className="text-muted-foreground/60 text-[11px] pt-1.5 mt-1 border-t border-border/60">
          {id.slice(0, 12)} · 结果持续发到本对话 · 重启即停
        </div>
      </div>
    </details>
  );
}

function LoopDetail({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground/70 w-12 shrink-0">{k}</span>
      <span className="text-foreground/90 min-w-0 break-words">{v}</span>
    </div>
  );
}

// Parse a loop round-marker message into its run number, one-line summary, and
// full markdown report. Reports often carry a preamble before the marker line
// ("Done — … Final report:\n\n---\n\n↻ loop `<id>` · run N — …"), so scan EVERY
// line for the marker (anchored at line start so an inline mention isn't a false
// round). Returns null when there's no marker line.
type LoopRun = { id: string; run: number; summary: string; full: string; createdAt: string | Date };
function parseLoopRun(row: { id: string; content: unknown; createdAt: string | Date }): LoopRun | null {
  const full = msgText(row.content);
  const line = full.split('\n').find((l) => /^\s*↻\s*loop\b.*\brun\s*\d+/i.test(l));
  if (!line) return null;
  const runM = /\brun\s*(\d+)/i.exec(line);
  if (!runM) return null;
  const dashM = /[—–]\s*(.+)$/.exec(line); // summary = text after the em/en dash
  const summary = (dashM ? dashM[1] : line).replace(/[*`]/g, '').trim();
  return { id: row.id, run: Number(runM[1]), summary, full, createdAt: row.createdAt };
}

// The "每轮结果" list inside an expanded LoopCard. Fetches the loop's round-marker
// messages directly (not bounded by the chat window) once the card is open;
// falls back to the latest result (un-truncated) if no markers are found yet.
function LoopRuns({
  sessionId,
  loopId,
  open,
  fallback,
}: {
  sessionId: string;
  loopId: string;
  open: boolean;
  fallback: string | null;
}) {
  const q = trpc.chat.loopRuns.useQuery(
    { sessionId, loopId },
    { enabled: open, refetchInterval: open ? 60_000 : false },
  );
  const runs = useMemo(() => {
    const parsed = (q.data ?? []).map(parseLoopRun).filter((r): r is LoopRun => r !== null);
    // Dedupe by run number — belt-and-suspenders for any echo that slips the SQL.
    const seen = new Set<number>();
    return parsed.filter((r) => (seen.has(r.run) ? false : (seen.add(r.run), true)));
  }, [q.data]);

  if (runs.length === 0) {
    if (!fallback) return null;
    return (
      <div className="pt-1">
        <div className="text-muted-foreground/70 text-[11px] mb-0.5">
          上次结果{q.isFetching ? ' · 加载每轮…' : ''}
        </div>
        <div className="text-foreground/90 whitespace-pre-wrap">{fallback}</div>
      </div>
    );
  }
  return (
    <div className="pt-1">
      <div className="flex items-center justify-between mb-1">
        <span className="text-muted-foreground/70 text-[11px]">每轮结果 ({runs.length})</span>
        <span className="text-muted-foreground/40 text-[10px]">最新在上 · 点开看完整</span>
      </div>
      {/* No inner max-h — the parent panel owns the single scroll region. */}
      <div className="-mx-1 px-1 space-y-1">
        {runs.map((r) => (
          <LoopRunRow key={r.id} run={r} />
        ))}
      </div>
    </div>
  );
}

// One round: a summary line (run N · time · 摘要); click expands the full report.
function LoopRunRow({ run }: { run: LoopRun }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-border/60 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2 py-1 text-left cursor-pointer hover:bg-accent/30 transition-colors"
      >
        <span className="font-mono text-[11px] text-muted-foreground shrink-0">run {run.run}</span>
        <span className="text-muted-foreground/45 text-[10px] tabular-nums shrink-0 hidden sm:inline">{relTime(run.createdAt)}</span>
        <span className="truncate text-foreground/85 text-[12px] min-w-0 flex-1">{run.summary || '(无摘要)'}</span>
        <ChevronDown className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div className="border-t border-border/50 px-2 py-1.5 text-[12px] overflow-x-auto">
          <Markdown>{run.full}</Markdown>
        </div>
      )}
    </div>
  );
}
