'use client';

// The loop/schedule strip above the composer: LoopBar (the strip itself) plus its
// LoopCard / LoopDetail / LoopRuns / LoopRunRow / ScheduleCard children and the
// parseLoopRun helper. Extracted verbatim from chat/page.tsx (P2-3); behaviour
// identical. Only LoopBar is consumed outside (by SessionPane); the rest stay
// module-private.

import { memo, useState, useMemo, useCallback } from 'react';
import { X, ChevronDown, Bot, CornerDownLeft } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { useScope } from '@/lib/use-scope';
import { Markdown } from '@/components/markdown';
import { CronRunRow, CronStatusBadge, cronDue, fmtDur, fmtEvery } from '@/components/cron-bits';
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
// details), a card per cron that REPORTS into this session (DB /cron rows via
// cron.listForReportSession — the "Schedule a task" / mcp cron_create flow), a
// compact count of any legacy scheduled routines, and a persistent
// "开启循环任务" suggestion that fills the composer with a template. Loop and
// legacy-schedule data is the opaque JSON the gateway forwards from
// `<agent_dir>/.loop-state.json` → `session.loopState`; the cron cards poll the
// dashboard DB directly.
// memo: LoopBar sits inside SessionPane and re-renders on every SSE tick / poll.
// It renders a Markdown-parsed loop lastResult per active loop, so an un-memo'd
// re-render re-parses that markdown ~4×/sec during a streaming reply (this very
// session has an active loop card). Its inputs are the loopState/disabled/
// sessionId props + the three onStart* callbacks (stabilized in SessionPane) +
// its own internal state and queries (which re-render it from inside, memo or
// not), so memo is behaviour-preserving and a real win when a card is shown.
export const LoopBar = memo(function LoopBar({
  loopState,
  onStartLoop,
  onStartCron,
  onStartAutonomy,
  takeover,
  disabled,
  sessionId,
  onJump,
}: {
  loopState: unknown;
  onStartLoop: () => void;
  onStartCron: () => void;
  onStartAutonomy: () => void;
  /**
   * The Brain-takeover control, when this session can have one. It sits FIRST in
   * this row — handing the conversation over belongs with "start a loop" and "run to
   * done": they're all "let it run without me", chosen at the moment you'd otherwise
   * type. It was a floating button; a floating button is for something you reach for
   * mid-scroll, and this isn't that.
   */
  takeover?: { active: boolean; busy: boolean; onToggle: () => void } | null;
  disabled?: boolean;
  sessionId: string;
  /**
   * Re-centre the timeline on a message — the chat page's anchored-window
   * `jumpTo`. Without it a round is readable only inside this card: the
   * timeline loads the newest 60 rows, and a looping session puts 25–141 rows
   * between consecutive rounds, so the round that just fired is usually already
   * off the first screenful. Optional, because a card rendered outside the chat
   * page has no timeline to move; the jump affordances hide when it is absent.
   *
   * Must be referentially stable — LoopBar is memo'd (see above).
   */
  onJump?: (messageId: string) => void;
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

  // Cron tasks that REPORT into this session — DB /cron rows, not the legacy
  // `.loop-state.json` schedules blob above. Their own poll rather than a ride on
  // loopState: crons live in the dashboard DB and move on the gateway's clock
  // (fires, status flips, run log), so the cards refresh the way the /cron page
  // does instead of waiting for the next agent-dir snapshot.
  const crons = trpc.cron.listForReportSession.useQuery(
    { sessionId },
    { refetchInterval: 10_000, staleTime: 5_000 },
  );

  return (
    <div className="shrink-0 bg-background pt-2">
      {/* Match ComposeBar's container (mx-auto w-full max-w-3xl px-3) exactly so
          the suggestion chip's left edge lines up with the composer box. */}
      <div className="mx-auto w-full max-w-3xl px-3 flex flex-col gap-1.5">
        {loops.map((l, i) => (
          <LoopCard key={typeof l.id === 'string' ? l.id : `loop-${i}`} loop={l} sessionId={sessionId} onDelete={onDeleteLoop} onJump={onJump} />
        ))}
        {(crons.data ?? []).map((c) => (
          <ScheduleCard key={c.id} cron={c} sessionId={sessionId} />
        ))}
        <div className="flex items-center gap-2 flex-wrap">
          {takeover && (
            <button
              type="button"
              onClick={takeover.onToggle}
              disabled={takeover.busy}
              aria-pressed={takeover.active}
              aria-label={takeover.active ? 'Take the conversation back (Brain is driving)' : 'Let Brain take over this conversation'}
              title={
                takeover.active
                  ? 'Brain is driving — click to take it back (typing does too)'
                  : 'Brain takeover — it reads this conversation, works out what you are after, and carries on for you'
              }
              className={cn(
                // Icon-only, sized to match the text chips beside it so the row keeps
                // one baseline. State lives in colour here rather than in a word,
                // which is why the active blue has to be unmistakable.
                'inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60',
                takeover.active
                  ? 'border-blue-500 bg-blue-500 text-white hover:bg-blue-600'
                  : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40',
              )}
            >
              <Bot className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
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
          {!disabled && (
            <button
              type="button"
              onClick={onStartAutonomy}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer"
            >
              <span className="text-amber-500" aria-hidden="true">⚡</span>
              Run to done
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
});

// One active loop, collapsed to a status line; click toggles a detail panel.
function LoopCard({ loop, sessionId, onDelete, onJump }: { loop: LoopEntry; sessionId: string; onDelete?: (id: string) => void; onJump?: (messageId: string) => void }) {
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
          {runCount != null && <span className="tabular-nums">{runCount} run{runCount === 1 ? '' : 's'}</span>}
          <span className="text-[10px] uppercase tracking-wide">{status}</span>
          {stopped && onDelete && (
            <button
              type="button"
              aria-label="delete stopped loop"
              title="Delete — removes it from this panel for good"
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
        {loop.prompt && <LoopDetail k="Task" v={loop.prompt} />}
        <LoopDetail k="Every" v={schedule} />
        {loop.kind && <LoopDetail k="Kind" v={loop.kind} />}
        {runCount != null && <LoopDetail k="Runs" v={`${runCount}`} />}
        {loop.lastRunAt && <LoopDetail k="Last" v={new Date(loop.lastRunAt).toLocaleString()} />}
        {loop.createdAt && <LoopDetail k="Started" v={new Date(loop.createdAt).toLocaleString()} />}
        <LoopRuns
          sessionId={sessionId}
          loopId={id}
          open={open}
          fallback={typeof loop.lastResult === 'string' ? loop.lastResult : null}
          onJump={onJump}
        />
        <div className="text-muted-foreground/60 text-[11px] pt-1.5 mt-1 border-t border-border/60">
          {id.slice(0, 12)} · results keep landing in this chat · a restart stops it
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

// The polled list row for one cron reporting into this session, as the server
// projects it (preview-capped prompt + unreadCount).
type ScheduleEntry = inferRouterOutputs<AppRouter>['cron']['listForReportSession'][number];

// One cron that reports into this session, collapsed to a status line; click
// toggles a detail panel. Mirrors LoopCard on purpose — to the reader a schedule
// IS a loop that fires on the gateway's clock instead of riding this
// conversation, so it gets the same card anatomy. The polled list row carries
// only a preview; the full prompt and the run log load via cron.get once the
// card is open (same lazy split as the /cron detail page), and run rows are the
// /cron page's own (CronRunRow), so expanding one marks it read everywhere.
function ScheduleCard({ cron, sessionId }: { cron: ScheduleEntry; sessionId: string }) {
  const scope = useScope();
  const utils = trpc.useUtils();
  // Track expansion so the detail query only fires once the card is open.
  const [open, setOpen] = useState(false);
  const detail = trpc.cron.get.useQuery(
    { id: cron.id },
    { enabled: open, refetchInterval: open ? 15_000 : false },
  );
  const runs = detail.data?.runs ?? [];
  const refresh = () => {
    utils.cron.listForReportSession.invalidate({ sessionId });
    utils.cron.get.invalidate({ id: cron.id });
  };
  const update = trpc.cron.update.useMutation({ onSuccess: refresh });
  const runNow = trpc.cron.runNow.useMutation({ onSuccess: refresh });
  // Reading a run = expanding it (same rule as /cron). Optimistically clear its
  // readAt in the detail cache so the dot drops this frame; the list invalidate
  // refreshes this card's own roll-up dot.
  const markRunRead = trpc.cron.markRunRead.useMutation({
    onMutate: async ({ runId }) => {
      await utils.cron.get.cancel({ id: cron.id });
      utils.cron.get.setData({ id: cron.id }, (old) =>
        old ? { ...old, runs: old.runs.map((r) => (r.id === runId ? { ...r, readAt: new Date() } : r)) } : old,
      );
    },
    onSettled: () => utils.cron.listForReportSession.invalidate({ sessionId }),
  });
  const markRead = useCallback((runId: string) => markRunRead.mutate({ runId }), [markRunRead.mutate]);

  // "starting soon…" when nextFire is at/just-before now — the ≤15s window after
  // Run now, and any overdue job (same rule as the /cron detail page).
  const queued = cronDue(cron.nextFire);
  const title = (cron.title ?? '').trim() || cron.prompt.slice(0, 60);

  return (
    <details
      className="group rounded-lg border border-border bg-card"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer list-none flex items-center gap-2 px-2.5 h-9 text-[12px]">
        <span
          className={cn('shrink-0', cron.enabled ? 'text-sky-500' : 'text-muted-foreground')}
          aria-hidden="true"
        >
          ⏰
        </span>
        <span className="font-medium text-foreground truncate">{title}</span>
        {!!(cron.title ?? '').trim() && (
          <span className="text-muted-foreground truncate hidden sm:inline">· {cron.prompt}</span>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0 text-muted-foreground">
          {cron.unreadCount > 0 && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-rose-500"
              aria-hidden="true"
              title={`${cron.unreadCount} unread run${cron.unreadCount === 1 ? '' : 's'}`}
            />
          )}
          <span className="tabular-nums hidden sm:inline">{fmtEvery(cron.intervalSec)}</span>
          <CronStatusBadge status={cron.lastStatus} enabled={cron.enabled} />
          <ChevronDown
            className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>
      {/* Same bounded panel as LoopCard: one scroll region so a long run log
          can't grow the shrink-0 strip and squeeze the conversation above it. */}
      <div className="border-t border-border px-3 py-2 text-[12px] space-y-1 max-h-[40vh] overflow-y-auto overscroll-contain">
        <LoopDetail k="Task" v={detail.data?.cron.prompt ?? cron.prompt} />
        <LoopDetail k="Every" v={`${fmtDur(cron.intervalSec)}${cron.jitterSec > 0 ? ` ±${fmtDur(cron.jitterSec)}` : ''}`} />
        <LoopDetail k="Next" v={queued ? 'starting soon…' : cron.nextFire ? new Date(cron.nextFire).toLocaleString() : '—'} />
        {cron.lastFire && <LoopDetail k="Last" v={new Date(cron.lastFire).toLocaleString()} />}
        <div className="flex items-center gap-1.5 pt-1">
          <button
            type="button"
            onClick={() => runNow.mutate({ id: cron.id })}
            disabled={runNow.isPending || queued}
            title="Run now — fires on the next gateway tick (≤15s)"
            className="inline-flex items-center gap-1 h-6 px-2 rounded border border-border text-[11px] text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            <span aria-hidden="true">▶</span> Run now
          </button>
          <button
            type="button"
            onClick={() => update.mutate({ id: cron.id, enabled: !cron.enabled })}
            disabled={update.isPending}
            title={cron.enabled ? 'Pause — keeps the cron and its run history' : 'Resume firing on schedule'}
            className={cn(
              'inline-flex items-center h-6 px-2 rounded border text-[11px] font-mono transition-colors cursor-pointer disabled:opacity-50',
              cron.enabled
                ? 'border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10'
                : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40',
            )}
          >
            {cron.enabled ? 'on' : 'off'}
          </button>
        </div>
        <div className="pt-1">
          <div className="text-muted-foreground/70 text-[11px] mb-1">
            Runs{open && detail.isPending ? ' · loading…' : runs.length > 0 ? ` (${runs.length})` : ''}
          </div>
          {runs.length === 0 ? (
            !detail.isPending && (
              <p className="text-muted-foreground text-[11px]">No runs yet — fires on schedule, or hit ▶.</p>
            )
          ) : (
            <ul className="space-y-1">
              {runs.map((r) => (
                <CronRunRow key={r.id} run={r} onRead={markRead} />
              ))}
            </ul>
          )}
        </div>
        <div className="text-muted-foreground/60 text-[11px] pt-1.5 mt-1 border-t border-border/60">
          {cron.id.slice(0, 12)} · runs isolated, reports land in this chat
          {/* /cron is machineProcedure-backed — a scoped share key can't open it,
              so don't offer the dead end there. */}
          {!scope.scoped && (
            <>
              {' · '}
              <a
                href={`/cron?id=${encodeURIComponent(cron.id)}`}
                className="underline underline-offset-2 hover:text-foreground"
              >
                manage in /cron
              </a>
            </>
          )}
        </div>
      </div>
    </details>
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
  onJump,
}: {
  sessionId: string;
  loopId: string;
  open: boolean;
  fallback: string | null;
  onJump?: (messageId: string) => void;
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
          Last result{q.isFetching ? ' · loading rounds…' : ''}
        </div>
        <div className="text-foreground/90 whitespace-pre-wrap">{fallback}</div>
      </div>
    );
  }
  return (
    <div className="pt-1">
      <div className="flex items-center justify-between mb-1">
        <span className="text-muted-foreground/70 text-[11px]">Rounds ({runs.length})</span>
        <div className="flex items-center gap-2">
          {/* The newest round is the one you came here for, and it is the one
              most likely to have scrolled out of the timeline's 60-row window. */}
          {onJump && (
            <button
              type="button"
              onClick={() => onJump(runs[0].id)}
              title="Show the newest round in the conversation"
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
              jump to newest
            </button>
          )}
          <span className="text-muted-foreground/40 text-[10px]">newest first · click to expand</span>
        </div>
      </div>
      {/* No inner max-h — the parent panel owns the single scroll region. */}
      <div className="-mx-1 px-1 space-y-1">
        {runs.map((r) => (
          <LoopRunRow key={r.id} run={r} onJump={onJump} />
        ))}
      </div>
    </div>
  );
}

// One round: a summary line (run N · time · 摘要); click expands the full report.
function LoopRunRow({ run, onJump }: { run: LoopRun; onJump?: (messageId: string) => void }) {
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
        <span className="truncate text-foreground/85 text-[12px] min-w-0 flex-1">{run.summary || '(no summary)'}</span>
        {/* A nested <button> would be invalid HTML inside the row button, so this
            is a span with a role — same affordance, no DOM nesting warning. */}
        {onJump && (
          <span
            role="button"
            tabIndex={0}
            aria-label={`show run ${run.run} in the conversation`}
            title="Show this round in the conversation"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onJump(run.id); }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              e.stopPropagation();
              onJump(run.id);
            }}
            className="inline-flex items-center justify-center h-5 w-5 shrink-0 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
          >
            <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
          </span>
        )}
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
