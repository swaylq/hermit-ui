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
//   amber  — needs you: the turn is parked on a permission prompt or a
//            question and will not move until you click. Same hue as working
//            (the session is mid-turn), but it pulses at you, not for you.
//   yellow — working: a turn is in flight.
//   green  — ready: alive + idle + you've seen the latest (caught up).
//   dim green — asleep: idle and caught up, but NOTHING IS RUNNING. Resumable,
//            not running. See `alive` below for why this had to grow a state.
//   red    — unread: alive + idle + the agent finished work you haven't read yet
//            ("上一个对话的任务都处理完了，等待阅读").
//   grey   — stale: the gateway has not reported on this session recently, so the
//            last `state` it wrote is a memory, not an observation. "Recently"
//            is counted in time this BROWSER could see the dashboard — see
//            snapshotSilenceMs.
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
  /**
   * Is a process actually running this session RIGHT NOW?
   *
   * This used to be decorative here — declared and never read — because on the
   * tmux backend it was true for every session that had ever started: a pane
   * outlives the gateway, so "has a pane" and "exists" were the same fact. On
   * claude-sdk they are not. The child is a gateway subprocess with no reattach
   * (chat-runner only reattaches tmux), so `alive` is false for every session
   * that has not been messaged since the last gateway restart — which is most
   * of them, most of the time.
   *
   * Reading it is therefore not a new opinion, it is the same one the colour
   * spec above always stated ("green — ALIVE + idle + caught up") finally being
   * enforced. `false` means asleep, not broken.
   */
  alive?: boolean | null;
  state?: string | null;
  /**
   * When the gateway last reported on this session. `state` is only evidence for
   * as long as this is recent: nothing clears a `state` of 'working' if the
   * gateway dies mid-turn, so without this the dot pulses amber forever. Absent
   * means "never snapshotted" (a brand-new session), which is NOT stale.
   */
  snapshotAt?: Date | string | null;
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
  /**
   * The one fact out of `activity` that the 5s sidebar poll needs, pre-chewed by
   * chat.listSessions so the blob itself does not ride that payload. Callers
   * that already have `activity` (getSession, sessionDetail) leave it undefined
   * and the blob answers instead — see backgroundStillRunning.
   */
  backgroundBusy?: boolean | null;
  /**
   * When the agent last said anything. Read for one purpose: deciding that an
   * outstanding background task has stopped being part of an answer — see
   * BACKGROUND_RESIDENT_MS.
   */
  lastMessageAt?: Date | string | null;
  claudeSessionId?: string | null;
  closedAt?: Date | string | null;
  // Set by chat.requestSessionRestart, cleared by the gateway once the pane is
  // gone. Non-null = the session is being recycled → 'restarting'.
  restartRequestedAt?: Date | string | null;
}

export interface StatusView {
  key: 'needs-you' | 'working' | 'unread' | 'ready' | 'starting' | 'restarting' | 'down' | 'stale' | 'asleep';
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
 * Did this session start work that has outlived the turn that started it?
 *
 * A backgrounded Bash and a backgrounded subagent both END THE TURN: measured
 * against claude 2.1.241, the model fires the tool, says a sentence, and the CLI
 * emits `result` and then `session_state_changed: idle` ~1ms later, while the
 * task runs on. The CLI re-invokes the model when it finishes, so the reply that
 * answers the question is one or more turns away — but for the seconds or
 * minutes in between, every "is it working" signal there is says no.
 *
 * That is why this exists as a fact separate from `state`. It must NOT be folded
 * into the gateway's `isWorking()`: that verdict also gates message DELIVERY
 * (the chat runner queues a message rather than interrupt a live turn), and a
 * session parked next to a long-lived background process would then swallow
 * everything typed at it. What it does gate is the two places that claim the
 * work is FINISHED — the status dot here, and the push in server/push/suppress.
 *
 * Shape-reading only, no judgement: `activity` is an opaque Json column, so a
 * payload from a newer gateway reads as "cannot say", never as "no".
 */
export function backgroundOutstanding(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const n = (raw as SessionActivity).backgroundCount;
  return typeof n === 'number' && n > 0;
}

/**
 * When a background task stops counting as part of the answer.
 *
 * Nothing guarantees a background task ever ends. Measured on the fleet the
 * afternoon this was written, four sessions sat idle with one outstanding —
 * "Wait for codex review to finish" (1h), a gateway watchdog (9h), and a
 * "Wait for smoke completion" left over from the previous DAY. Treating those as
 * work-in-progress for ever would replace the lie this fixes with its mirror
 * image: a session that looks busy and is not, and that can never go red or ring
 * a phone again.
 *
 * So half an hour after the agent's last word, an outstanding task is read as a
 * resident process — a dev server someone left running — rather than a step in
 * the answer.
 *
 * EXPORTED AND SHARED with the push gate, unlike every other threshold in this
 * file, which server/push/suppress deliberately keeps its own copy of. The
 * reason is specific: the dot and the notification must call a task resident at
 * the SAME moment. Two numbers means a window where the sidebar says a session
 * is still working while its phone notification has already gone out, or the
 * reverse — a red dot and silence.
 */
export const BACKGROUND_RESIDENT_MS = 30 * 60_000;

/**
 * The same question as `backgroundOutstanding`, asked of a whole session row —
 * whichever of the two doors that row came through. Neither source may say
 * "no" on behalf of a payload it does not carry, so this is an OR: the sidebar
 * row has only the boolean, the chat header has only the blob, and a row with
 * neither means the backend cannot say, which is not the same as idle.
 */
function backgroundStillRunning(s: SessionRuntimeLike, now: number): boolean {
  if (s.backgroundBusy !== true && !backgroundOutstanding(s.activity)) return false;
  // Since the agent's last word, not since the task started: what is being asked
  // is whether a reply is still coming, and the agent going quiet for half an
  // hour is the evidence that one is not. A row with no lastMessageAt has never
  // been spoken in, so there is no silence to measure and nothing to expire.
  const last = toMs(s.lastMessageAt);
  if (last != null && now - last >= BACKGROUND_RESIDENT_MS) return false;
  return true;
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

/**
 * How long a session's `state` stays believable after the gateway last spoke.
 *
 * The snapshot tick is 8s, so this is ~5 missed ticks: long enough that a pm2
 * restart or one slow tick does not grey the whole sidebar, short enough that a
 * gateway which has actually stopped is visible before you act on what it last
 * said. Nothing else expires `state` — the DB row is a last-write-wins cache
 * with no TTL of its own.
 */
export const SNAPSHOT_STALE_MS = 45_000;

/**
 * Resting states: the session is fine and nothing is happening. The sidebar
 * prints a label for every OTHER state, so this is what keeps a list of idle
 * sessions from being a column of the word "asleep" — the dot already says it,
 * and the row's tooltip spells it out.
 */
export function isRestingState(key: StatusView['key']): boolean {
  return key === 'ready' || key === 'asleep';
}

function toMs(at: Date | string | null | undefined): number | null {
  if (at == null) return null;
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * How long the gateway has been silent about this session — counting only time
 * this browser could actually see the dashboard.
 *
 * The distinction is the whole point. `now - snapshotAt` answers "how old is the
 * number in my hand", which is ALSO large when the browser is the thing that
 * stopped asking: a poll queued behind a stalled dashboard, a backgrounded tab,
 * a dropped connection. Charging that to the gateway is what made a session
 * mid-long-task flicker grey every time a tool finished — the big sync POST that
 * a finishing tool produces is exactly what stalls the polls. See
 * lib/dashboard-reach for the full trace.
 *
 * Two corrections, both from `dashboardReach()`:
 *
 *   `observedAt` — measure from the last answer we actually GOT, not from the
 *   wall clock. A poll that never came back says nothing about the gateway, so
 *   it must not age anything. 0 means we have never had an answer (first paint
 *   off the local cache), which is no basis to judge: `null`, not stale.
 *
 *   `reachableSince` — start the clock no earlier than the moment our current
 *   run of contact began. When the DASHBOARD is the thing that went down, the
 *   gateway could not write either, so on recovery the snapshot is legitimately
 *   ancient through no fault of the gateway's. That silence was shared; it is
 *   not evidence, and it is not charged. The grace it buys is bounded by this
 *   same threshold — 45s after contact resumes, a gateway that is still quiet
 *   is called out.
 *
 * Omitting both (a caller with no reach information, and every existing test)
 * keeps the original wall-clock behaviour.
 *
 * Clamped at 0: the browser's clock and the dashboard's are independent, and a
 * browser running behind the server would otherwise report negative silence.
 * Skew the other way still inflates this — nothing client-side can see it, and
 * it is no worse than what this replaced.
 */
export function snapshotSilenceMs(
  snapshotAt: Date | string | null | undefined,
  opts: { now?: number; observedAt?: number; reachableSince?: number } = {},
): number | null {
  const snap = toMs(snapshotAt);
  if (snap == null) return null;
  const observedAt = opts.observedAt === undefined ? opts.now ?? Date.now() : opts.observedAt;
  if (!observedAt) return null; // never heard from the dashboard — nothing to judge on
  const silentSince = Math.max(snap, opts.reachableSince ?? 0);
  return Math.max(0, observedAt - silentSince);
}

export function sessionStatusView(
  s: SessionRuntimeLike | null | undefined,
  opts: {
    liveWorking?: boolean;
    unread?: boolean;
    needsYou?: boolean;
    now?: number;
    /**
     * This browser's contact with the dashboard, from `dashboardReach()` —
     * spread it in (`...dashboardReach()`) and snapshotSilenceMs does the rest.
     * Without it the staleness clock runs on the wall clock and blames the
     * gateway for the browser's own blind spells.
     */
    observedAt?: number;
    reachableSince?: number;
  } = {},
): StatusView {
  // amber — blocked ON YOU. Only a view that has the session's messages loaded
  // can see this (a {type:'interaction'} block still pending), which is why it
  // used to be an object literal inlined in the chat header, outside this
  // union — and therefore something the sidebar could never render. It lives
  // here now, and the chat page hands the fact to the sidebar through
  // lib/session-live so both sides run this same function.
  //
  // Outranks working: the turn is not advancing, it is parked until you click.
  if (opts.needsYou) {
    return { key: 'needs-you', label: 'needs you', dot: 'bg-amber-400', pulse: true };
  }
  // A backend that can say WHAT it is doing gets to say it here; one that
  // cannot keeps the label it always had.
  const working = (): StatusView => {
    const a = activityLabel(s?.activity);
    return {
      key: 'working',
      label: a?.label ?? 'working',
      dot: 'bg-amber-400',
      pulse: true,
      detail: a?.detail,
    };
  };
  // yellow — working, as the BROWSER sees it. Split out from the server's
  // `state` below and kept above every other check: this is the open chat page
  // reading its own message stream, so it is both faster than the snapshot and
  // still true when the gateway is the thing that has gone quiet.
  if (opts.liveWorking) return working();
  // grey — down / not active.
  if (!s) return { key: 'down', label: '—', dot: 'bg-zinc-400', pulse: false };
  // Closed outranks a server 'working' now, which it did not before. The gateway
  // only polls sessions with closedAt = null, so a session archived mid-turn
  // keeps whatever `state` it died on — and pulsed amber forever, for a
  // conversation that is over.
  if (s.closedAt) return { key: 'down', label: 'closed', dot: 'bg-zinc-400', pulse: false };
  // grey — the gateway has stopped reporting, so `state` is a memory. Ranked
  // above it deliberately: the failure this exists for is a gateway that died
  // while a session was 'working', where the row says "working" indefinitely and
  // nothing in the pipeline ever contradicts it. Everything below this line
  // reads `state` or `alive`, and neither is evidence once it is this old.
  //
  // What it must NOT do is fire when the browser is the quiet one. That is a
  // different fault with the same symptom, it is the common one, and it is the
  // reason the age is snapshotSilenceMs rather than a subtraction from now.
  const age = snapshotSilenceMs(s.snapshotAt, opts);
  if (age != null && age > SNAPSHOT_STALE_MS) {
    return {
      key: 'stale',
      label: 'stale',
      dot: 'bg-zinc-400',
      pulse: false,
      detail: 'the gateway has not reported on this session recently — this is the last state it saw',
    };
  }
  // yellow — working, as the gateway last observed it.
  if (s.state === 'working') return working();
  // yellow — the turn ended, the work it started did not. A backgrounded Bash or
  // subagent lands the CLI in `idle` within a millisecond of firing, and the
  // model only wakes again when the task reports back. Falling through from here
  // reached 'unread' — the red dot whose whole meaning is "the agent FINISHED
  // work you have not read" — for a session that had done nothing but say "let
  // me kick this off". Ranked with `working` rather than below it because that
  // is what it is: something is running, and the reply is still to come. Bounded
  // by BACKGROUND_RESIDENT_MS, so a task nobody is waiting on cannot pin a
  // session amber for a day.
  if (s.state === 'idle' && backgroundStillRunning(s, opts.now ?? Date.now())) return working();
  // sky — recycling: a restart was requested; the pane is being killed and will
  // respawn on the next message. Outranks the !alive check below, since `alive`
  // flips false mid-restart and we want "restarting", not "exited".
  if (s.restartRequestedAt) {
    return { key: 'restarting', label: 'restarting', dot: 'bg-sky-400', pulse: true };
  }
  // A dead pane is still NOT "down": a restarted/crashed session is resumable —
  // the next message `--resume`s it (history intact) or spawns fresh — so it
  // falls through to asleep/unread rather than a grey "exited" dead-end, and the
  // composer stays enabled. What changed is that it no longer arrives at the
  // SOLID green "ready", which claimed a live process there was none of.
  // sky — pane up but claude still booting (no transcript yet).
  if (s.state === 'starting') {
    return { key: 'starting', label: 'starting', dot: 'bg-sky-400', pulse: true };
  }
  // idle → red if there's unread finished work, else green (caught up). Unread
  // outranks asleep: "the agent finished something you have not read" is the
  // fact worth a colour, whether or not a process is still up to hear about it.
  if (opts.unread) return { key: 'unread', label: 'unread', dot: 'bg-rose-500', pulse: false };
  // dim green — nothing is running. Same family as ready because nothing is
  // wrong: the next message resumes the conversation with its history intact.
  // But it is not `ready`, and saying so was the whole lie — see `alive` above.
  if (s.alive === false) {
    return {
      key: 'asleep',
      label: 'asleep',
      dot: 'bg-emerald-500/30',
      pulse: false,
      detail: 'nothing is running — your next message wakes it with the conversation intact',
    };
  }
  return { key: 'ready', label: 'ready', dot: 'bg-emerald-500', pulse: false };
}
