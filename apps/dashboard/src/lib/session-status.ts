// Single source of truth for how a ChatSession's runtime state renders, so the
// chat header, the agent-detail sheet, and the app sidebar can never drift
// apart again. The gateway's session-snapshot derives `state` from the pane's
// actual Claude Code TUI (capture-pane → "esc to interrupt" = working), so these
// labels match exactly what the user sees in the terminal.
//
// Colour scheme (sway's spec):
//   grey   — down / not active: no session, dead pane, closed.
//   sky    — coming up: claude is booting (starting) or the pane is being
//            recycled by a restart (restarting). Transient; pulses.
//   yellow — working: a turn is in flight.
//   green  — ready: alive + idle + you've seen the latest (caught up).
//   red    — unread: alive + idle + the agent finished work you haven't read yet
//            ("上一个对话的任务都处理完了，等待阅读").
//
// `liveWorking` lets a caller with a faster client-side signal (the chat page
// knows a turn started via its SSE stream before the next ~15s gateway snapshot)
// force the working state. `unread` is computed client-side from a per-session
// localStorage "last read" stamp vs the session's lastMessageAt — see
// lib/session-read.ts. The currently-viewed session passes `unread: false` (you
// are, by definition, reading it).

/**
 * What a session is doing right now, as the gateway's claude-sdk runtime
 * reports it. Mirrors RuntimeActivity in the gateway; it arrives through an
 * opaque JSON column, so every field is read defensively.
 */
export interface SessionActivity {
  kind?: string | null;
  label?: string | null;
  detail?: string | null;
  elapsedSec?: number | null;
  attempt?: number | null;
  maxRetries?: number | null;
  retryInSec?: number | null;
  backgroundCount?: number | null;
}

export interface SessionRuntimeLike {
  alive?: boolean | null;
  state?: string | null;
  /**
   * Only the backends with a typed event stream fill this in. Absent means "this
   * backend cannot say", NOT "idle" — so it only ever REFINES the working label
   * and never contradicts `state`.
   *
   * Typed `unknown` because that is what it is: an opaque Prisma Json? column,
   * so the shape is a promise made by the gateway and not by the type system.
   * `activityLabel` narrows it and returns null on anything it does not
   * recognise, which is also what a payload from a newer gateway looks like.
   */
  activity?: unknown;
  claudeSessionId?: string | null;
  closedAt?: Date | string | null;
  // Set by chat.requestSessionRestart, cleared by the gateway once the pane is
  // gone. Non-null = the session is being recycled → 'restarting'.
  restartRequestedAt?: Date | string | null;
}

export interface StatusView {
  key: 'working' | 'unread' | 'ready' | 'starting' | 'restarting' | 'down';
  label: string;
  dot: string;   // Tailwind bg-* for the status dot
  pulse: boolean; // animate the dot (working / starting)
  /** Longer qualification for a tooltip — the command, the task, the retry. */
  detail?: string;
}

/** `47s`, `3m 20s` — short enough to sit in a header chip. */
function shortDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/**
 * The working label, sharpened by whatever the backend could tell us.
 *
 * "working" is all a scraped terminal spinner can support. With a typed stream
 * the same state can say WHICH tool and for how long, or that the session is not
 * slow but rate-limited — the difference between a chat that looks hung and one
 * that explains itself. Falls back to plain "working" whenever the payload is
 * missing or malformed: this is a JSON column, so nothing in it is guaranteed.
 */
export function activityLabel(raw: unknown): { label: string; detail?: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as SessionActivity;
  const bg = typeof a.backgroundCount === 'number' && a.backgroundCount > 0
    ? ` +${a.backgroundCount} bg`
    : '';

  if (a.kind === 'retrying') {
    const wait = typeof a.retryInSec === 'number' && a.retryInSec > 0 ? `, ${a.retryInSec}s` : '';
    const n = a.attempt && a.maxRetries ? ` ${a.attempt}/${a.maxRetries}` : '';
    return { label: `retrying${n}${wait}`, detail: a.detail ?? 'the API asked us to back off' };
  }
  if (a.kind === 'compacting') return { label: `compacting${bg}`, detail: a.detail ?? undefined };
  if (a.kind === 'subagent') {
    return { label: `${a.label || 'subagent'}${bg}`, detail: a.detail ?? undefined };
  }
  if (a.kind === 'tool') {
    const t = typeof a.elapsedSec === 'number' && a.elapsedSec > 0 ? ` · ${shortDuration(a.elapsedSec)}` : '';
    return { label: `${a.label || 'tool'}${t}${bg}`, detail: a.detail ?? undefined };
  }
  if (a.kind === 'background') {
    return { label: `background${bg}`, detail: a.detail ?? undefined };
  }
  if (a.kind === 'thinking') return { label: `thinking${bg}`, detail: a.detail ?? undefined };
  return null;
}

export function sessionStatusView(
  s: SessionRuntimeLike | null | undefined,
  opts: { liveWorking?: boolean; unread?: boolean } = {},
): StatusView {
  // yellow — working wins over everything.
  if (opts.liveWorking || s?.state === 'working') {
    // A backend that can say WHAT it is doing gets to say it here; one that
    // cannot keeps the label it always had.
    const a = activityLabel(s?.activity);
    return {
      key: 'working',
      label: a?.label ?? 'working',
      dot: 'bg-amber-400',
      pulse: true,
      detail: a?.detail,
    };
  }
  // grey — down / not active.
  if (!s) return { key: 'down', label: '—', dot: 'bg-zinc-400', pulse: false };
  if (s.closedAt) return { key: 'down', label: 'closed', dot: 'bg-zinc-400', pulse: false };
  // sky — recycling: a restart was requested; the pane is being killed and will
  // respawn on the next message. Outranks the !alive check below, since `alive`
  // flips false mid-restart and we want "restarting", not "exited".
  if (s.restartRequestedAt) {
    return { key: 'restarting', label: 'restarting', dot: 'bg-sky-400', pulse: true };
  }
  // A dead pane is NOT "down": a restarted/crashed session is still resumable —
  // the next message `--resume`s it (history intact) or spawns fresh. Fall through
  // to ready/unread so it reads as usable right away (no first message needed) and
  // the composer stays enabled, instead of a grey "exited" dead-end.
  // sky — pane up but claude still booting (no transcript yet).
  if (s.state === 'starting') {
    return { key: 'starting', label: 'starting', dot: 'bg-sky-400', pulse: true };
  }
  // alive + idle → red if there's unread finished work, else green (caught up).
  if (opts.unread) return { key: 'unread', label: 'unread', dot: 'bg-rose-500', pulse: false };
  return { key: 'ready', label: 'ready', dot: 'bg-emerald-500', pulse: false };
}
