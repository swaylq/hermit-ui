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

export interface SessionRuntimeLike {
  alive?: boolean | null;
  state?: string | null;
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
}

export function sessionStatusView(
  s: SessionRuntimeLike | null | undefined,
  opts: { liveWorking?: boolean; unread?: boolean } = {},
): StatusView {
  // yellow — working wins over everything.
  if (opts.liveWorking || s?.state === 'working') {
    return { key: 'working', label: 'working', dot: 'bg-amber-400', pulse: true };
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
