'use client';

// The schedule strip above the composer: ScheduleBar (the strip itself) plus its
// ScheduleCard / DetailRow children. Only ScheduleBar is consumed outside (by
// SessionPane); the rest stay module-private.
//
// There used to be a second card here — the session-scoped LOOP, read out of
// `<agent_dir>/.loop-state.json`. Loop and cron were the same feature described
// twice (a cron has reported into the chat that created it since the
// reportSessionId migration), so the loop is gone and a cron absorbed both jobs.
// See docs/cron-merge-design.md.

import { memo, useState, useCallback, useEffect, useRef } from 'react';
import { ChevronDown, Bot, Eye, X } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useScope } from '@/lib/use-scope';
import { CronRunRow, CronStatusBadge, cronDue, fmtDur, fmtEvery } from '@/components/cron-bits';

// Strip above the composer: a card per cron that REPORTS into this session (DB
// /cron rows via cron.listForReportSession — the "Schedule a task" /
// "Iterate to done" / mcp cron_create flow), plus the persistent suggestion chips
// that fill the composer with a template.
//
// memo: ScheduleBar sits inside SessionPane and re-renders on every SSE tick /
// poll. Its inputs are the disabled/sessionId props + the three onStart*
// callbacks (stabilized in SessionPane) + its own internal state and queries
// (which re-render it from inside, memo or not), so memo is behaviour-preserving
// and a real win when a card is shown.
export const ScheduleBar = memo(function ScheduleBar({
  onStartIterate,
  onStartCron,
  onStartAutonomy,
  onStartPerfect,
  onStartPureChat,
  pureChatBusy,
  takeover,
  disabled,
  sessionId,
  chatOnly,
}: {
  onStartIterate: () => void;
  onStartCron: () => void;
  onStartAutonomy: () => void;
  onStartPerfect: () => void;
  /**
   * Start a NEW pure-chat session with the same agent — this conversation is
   * left exactly as it is.
   *
   * It cannot be a switch on THIS session: the read-only tool surface is chosen
   * when the child process is spawned, so flipping it on a live one would
   * change nothing until a respawn (docs/chat-only-mode.md).
   */
  onStartPureChat: () => void;
  /** The createSession call is in flight — the collapsed icon shows a spinner dot. */
  pureChatBusy?: boolean;
  /**
   * The Brain-takeover control, when this session can have one. It sits FIRST in
   * this row — handing the conversation over belongs with "iterate to done" and
   * "run to done": they're all "let it run without me", chosen at the moment you'd
   * otherwise type. It was a floating button; a floating button is for something you reach for
   * mid-scroll, and this isn't that.
   */
  takeover?: { active: boolean; busy: boolean; onToggle: () => void } | null;
  disabled?: boolean;
  sessionId: string;
  /**
   * Pure-chat session: the whole chip row is replaced by a marker saying so.
   *
   * Not a cosmetic choice. Every chip in that row asks the agent to go away and
   * work — iterate to done, schedule a task, run to done, perfect it, hand over
   * to Brain — and a pure-chat session can do none of them: no sub-agents, and
   * cron_create is denied at the MCP stub. Offering them would be offering
   * buttons that fail after you press them. The row is also the last thing you
   * read before typing, which makes it the right place to say what this session
   * is — better than a chip in the header meta line, where it reads as one more
   * attribute rather than as the shape of the conversation.
   */
  chatOnly?: boolean;
}) {
  // Cron tasks that REPORT into this session — DB /cron rows. Their own poll:
  // crons live in the dashboard DB and move on the gateway's clock (fires, status
  // flips, run log), so the cards refresh the way the /cron page does.
  const crons = trpc.cron.listForReportSession.useQuery(
    { sessionId },
    { refetchInterval: 10_000, staleTime: 5_000 },
  );

  return (
    <div className="shrink-0 bg-background pt-2">
      {/* Match ComposeBar's container (mx-auto w-full max-w-3xl px-3) exactly so
          the suggestion chip's left edge lines up with the composer box. */}
      <div className="mx-auto w-full max-w-3xl px-3 flex flex-col gap-1.5">
        {(crons.data ?? []).map((c) => (
          <ScheduleCard key={c.id} cron={c} sessionId={sessionId} />
        ))}
        {/* One line, always. It used to wrap, which moved the composer down by a
            row on a phone — the thing you are about to type into jumping is worse
            than a chip you have to swipe for. So it scrolls sideways instead.
            `-mx-3 px-3` cancels the parent's padding for the SCROLL box only: the
            chips still start aligned with the composer, but a chip scrolling out
            runs off the screen edge rather than stopping 12px short of it.
            `overscroll-x-contain` keeps a swipe past the end from turning into
            iOS Safari's back-navigation gesture. */}
        {chatOnly ? (
          <div className="flex items-center gap-2 -mx-3 px-3 py-0.5">
            <span
              title="Pure chat: read-only tools. It can read files, search the web and add to its own memory — it cannot write or edit files, run commands, spawn sub-agents or schedule work. Fixed when the session was opened; start a new session to change it."
              className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-dashed border-border text-[12px] text-muted-foreground"
            >
              <Eye className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
              pure chat
            </span>
            {/* Dashed border and no hover: this row is otherwise all buttons, and
                the one thing it must not look like is another one. */}
            <span className="min-w-0 truncate text-[11px] leading-tight text-muted-foreground/80">
              read-only — it can look things up and remember, nothing else
            </span>
          </div>
        ) : (
        <div className="flex items-center gap-2 -mx-3 px-3 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Leftmost, and folded to a 28px icon: every other chip in this row
              steers the conversation you are already in, and this one leaves it
              to start a different one. It has to be reachable without scrolling
              the row, and it must not look like a fifth thing to ask this agent
              to do — so it takes the least width a control can take until you
              touch it. Not gated on `disabled`: a closed session can still be
              the place you decide to go and talk to the same agent. */}
          <PureChatChip onStart={onStartPureChat} busy={pureChatBusy} />
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
                'shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60',
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
              onClick={onStartIterate}
              className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer"
            >
              <span className="text-emerald-500" aria-hidden="true">↻</span>
              Iterate to done
            </button>
          )}
          {!disabled && (
            <button
              type="button"
              onClick={onStartCron}
              className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer"
            >
              <span className="text-sky-500" aria-hidden="true">⏰</span>
              Schedule a task
            </button>
          )}
          {!disabled && (
            <button
              type="button"
              onClick={onStartAutonomy}
              title="Stop asking me to confirm — carry on with your own recommendation until the task is finished"
              className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer"
            >
              <span className="text-amber-500" aria-hidden="true">⚡</span>
              Run to done
            </button>
          )}
          {/* The strictest of the three, so it sits last: "Run to done" stops when
              the agent thinks it is finished, this one stops when a fresh critic
              finds no real problem left, within a 24-hour budget (the perfect-goal skill). */}
          {!disabled && (
            <button
              type="button"
              onClick={onStartPerfect}
              title="Write the goal as a checkable list, then keep going until a fresh critic finds no real problem — within 24 hours"
              className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer"
            >
              <span className="text-violet-500" aria-hidden="true">◎</span>
              Perfect it
            </button>
          )}
        </div>
        )}
      </div>
    </div>
  );
});

// How long the opened chip refuses a click, and how long it stays open with
// nothing else happening.
//
// The guard exists for the same reason ConfirmIconButton has one: the tap that
// OPENS this control and the tap that fires it land on the same pixels — the
// row is left-anchored, so the chip grows RIGHTWARD out of the icon and its
// first 28px are exactly where the icon was. Without a dead time an impatient
// double-tap would create a session the user only pointed at. 350ms clears
// iOS's ~300ms double-tap window; a click inside it is dropped and the chip
// stays open, so nothing is silently swallowed.
//
// Which child sits first is load-bearing for the same reason, and the answer is
// the MIRROR of ConfirmIconButton's: that one is right-anchored and grows
// leftward, so its confirm goes last. This one grows rightward, so the action
// goes FIRST — second tap in the same place means yes, which is what everyone
// tries.
const PURE_CHAT_GUARD_MS = 350;
const PURE_CHAT_AUTO_CLOSE_MS = 6_000;

// "Start a pure chat" — folded to an icon by default, one tap to see what it is,
// a second to open the session.
//
// Folded rather than a labelled chip because of what it costs to press by
// accident: it navigates away from the conversation on screen. The other chips
// in this row fill the composer with a template, which you can simply delete.
function PureChatChip({ onStart, busy }: { onStart: () => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const openedAt = useRef(0);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), PURE_CHAT_AUTO_CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]);

  const settled = () => Date.now() - openedAt.current >= PURE_CHAT_GUARD_MS;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { openedAt.current = Date.now(); setOpen(true); }}
        disabled={busy}
        aria-expanded={false}
        aria-label="pure chat"
        title="Pure chat — opens a NEW read-only session with this agent. Tap to see what it does."
        className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors cursor-pointer hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? (
          <span className="text-[11px] leading-none" aria-hidden="true">&#8230;</span>
        ) : (
          <Eye className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
        )}
      </button>
    );
  }

  return (
    <span className="shrink-0 inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => { if (!settled()) return; setOpen(false); onStart(); }}
        title="Opens a NEW session with the same agent, read-only: it can look at files, search the web and add to its own memory, but cannot write, edit, run commands or spawn sub-agents. This conversation is untouched."
        className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground hover:bg-accent/40 transition-colors cursor-pointer"
      >
        <Eye className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
        New pure chat
      </button>
      <button
        type="button"
        onClick={() => { if (settled()) setOpen(false); }}
        aria-label="close"
        title="close"
        className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {/* What it is, in the one place you will read it: on a phone there is no
          hover, so the title attribute above is desktop-only. */}
      <span className="shrink-0 whitespace-nowrap text-[11px] leading-tight text-muted-foreground/80">
        read-only, same agent &#183; this chat stays as it is
      </span>
    </span>
  );
}

function DetailRow({ k, v }: { k: string; v: string }) {
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
// toggles a detail panel. This is now the ONLY card in the strip — a 定时任务 and
// a 循环 are the same row. The polled list row carries
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
  // Finished its own goal (a run printed CRON_DONE) — distinct from a human
  // pausing it, even though both are `enabled: false`. Switching it back on
  // clears doneAt server-side, so the two controls stay one toggle.
  const done = cron.doneAt != null;

  return (
    <details
      className="group rounded-lg border border-border bg-card"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer list-none flex items-center gap-2 px-2.5 h-9 text-[12px]">
        <span
          className={cn(
            'shrink-0',
            done ? 'text-emerald-500' : cron.enabled ? 'text-sky-500' : 'text-muted-foreground',
          )}
          aria-hidden="true"
        >
          {done ? '✓' : '⏰'}
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
          <CronStatusBadge status={cron.lastStatus} enabled={cron.enabled} done={done} />
          <ChevronDown
            className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>
      {/* Bounded panel: one scroll region so a long run log can't grow the
          shrink-0 strip and squeeze the conversation above it. */}
      <div className="border-t border-border px-3 py-2 text-[12px] space-y-1 max-h-[40vh] overflow-y-auto overscroll-contain group-open:animate-in group-open:fade-in-0 group-open:duration-150">
        <DetailRow k="Task" v={detail.data?.cron.prompt ?? cron.prompt} />
        <DetailRow k="Every" v={`${fmtDur(cron.intervalSec)}${cron.jitterSec > 0 ? ` ±${fmtDur(cron.jitterSec)}` : ''}`} />
        {done ? (
          <DetailRow k="Done" v={new Date(cron.doneAt!).toLocaleString()} />
        ) : (
          <DetailRow k="Next" v={queued ? 'starting soon…' : cron.nextFire ? new Date(cron.nextFire).toLocaleString() : '—'} />
        )}
        {cron.lastFire && <DetailRow k="Last" v={new Date(cron.lastFire).toLocaleString()} />}
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
            title={
              cron.enabled
                ? 'Pause — keeps the cron and its run history'
                : done
                  ? 'It reached its goal and stopped. Switching it on starts it running again.'
                  : 'Resume firing on schedule'
            }
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
          {cron.id.slice(0, 12)} · {done ? 'finished — reports stay on /cron' : 'runs isolated, reports land in this chat'}
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
