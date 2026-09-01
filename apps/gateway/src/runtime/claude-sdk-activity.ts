// What a claude-sdk session is doing right now, derived from its message stream.
//
// The pane could only ever answer "working or not", because the only signal it
// had was a spinner scraped off a terminal. The SDK stream says which tool, for
// how long, which subagent, whether the API is rate-limiting us and for how
// long, and what is running in the background. This turns that into one small
// structure the dashboard can render instead of a dot.
//
// Pure and side-effect free — a reducer over messages plus a formatter — so the
// whole vocabulary is unit-testable without a live claude. Same split as
// claude-sdk-events.ts.
//
// ── On not using `tool_progress` as the primary signal ───────────────────────
// The SDK has a `tool_progress` message carrying `elapsed_time_seconds`, which
// looks like exactly the right input. Measured against 2.1.238, it does not
// arrive for an ordinary foreground Bash — a 20-second one produced none — so
// anything built on it alone would report nothing for the case that matters
// most. What IS guaranteed is the pair the transcript is made of: an assistant
// `tool_use` block starts a tool and a `tool_result` ends it. That is the same
// derivation `pane.ts:transcriptToolRunning` makes for the tmux path, and it
// needs no options turned on. `tool_progress` is still consumed when it does
// arrive, to sharpen the elapsed time.

/** A tool the model started and has not yet got a result for. */
export type RunningTool = {
  toolUseId: string;
  name: string;
  /** First line of the command / path / pattern — enough to recognise it. */
  detail: string | null;
  startedAtMs: number;
  /** Set once `tool_progress` confirms it, which is more accurate than our clock. */
  reportedElapsedSec?: number;
  /** Non-null when the tool belongs to a subagent rather than the main loop. */
  parentToolUseId: string | null;
};

export type ActivityState = {
  tools: Map<string, RunningTool>;
  /** Subagent / background Task runs, by task_id. */
  tasks: Map<string, { description: string; subagentType?: string; lastTool?: string }>;
  /** The CLI's own status frame. */
  status: 'requesting' | 'compacting' | null;
  /**
   * The CLI's own turn boundary — see `sessionBusy` below, which is the only
   * thing that reads it.
   *
   * `null` means no frame has ever arrived: either the turn has not started, or
   * this CLI does not emit them (they are gated behind
   * `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`, which claude-sdk.ts sets).
   * Deliberately NOT reset by a `result`, because `idle` arrives AFTER it.
   */
  sessionState: 'idle' | 'running' | 'requires_action' | null;
  /** Set while the API is being retried; cleared by the next successful frame. */
  retry: { attempt: number; maxRetries: number; delayMs: number; atMs: number } | null;
  /**
   * Live background tasks, keyed by task_id.
   *
   * The CLI's `background_tasks_changed` payload is the WHOLE set every time, so
   * this is rebuilt on each frame — but a task keeps the moment it was FIRST
   * seen, which is the only place an age can come from. That age is the point:
   * "background" on its own cannot tell a 3-second build from a `du` over
   * ~/Library that will never finish, and both look identical in the sidebar.
   */
  background: Map<string, BackgroundTask>;
};

/** One thing running outside the turn — a backgrounded Bash, or a subagent. */
export type BackgroundTask = {
  taskId: string;
  /** The Bash `description` / the subagent's task, as the CLI reported it. */
  description: string;
  /** First frame this id appeared in. Survives every later REPLACE. */
  startedAtMs: number;
};

/**
 * How many background tasks the snapshot names. Past a handful the list stops
 * being a thing you read and starts being weight on a column rewritten every 8s
 * for every session on the machine; `backgroundCount` still says how many there
 * really are.
 */
const BACKGROUND_LIST_CAP = 6;

export function newActivityState(): ActivityState {
  return { tools: new Map(), tasks: new Map(), status: null, sessionState: null, retry: null, background: new Map() };
}

/**
 * Whether the CLI says a turn is in flight, or null when it has not said.
 *
 * Split out so `isWorking` reads one named predicate instead of re-deriving the
 * "which states count as busy" rule at the call site. `requires_action` counts:
 * a session parked waiting on something is not a session you are caught up with.
 */
export function sessionBusy(st: ActivityState): boolean | null {
  if (st.sessionState == null) return null;
  return st.sessionState !== 'idle';
}

/** What the dashboard renders. Deliberately small and already human-facing. */
export type RuntimeActivity = {
  kind: 'tool' | 'subagent' | 'compacting' | 'retrying' | 'thinking' | 'background';
  /** Short noun for the chip: a tool name, or a state. */
  label: string;
  /** One line of qualification — the command, the task, the retry reason. */
  detail?: string;
  /** Whole seconds the current thing has been running. */
  elapsedSec?: number;
  attempt?: number;
  maxRetries?: number;
  /** Seconds until the next retry, when the API asked us to wait. */
  retryInSec?: number;
  /** How many tasks are running in the background, when any are. */
  backgroundCount?: number;
  /**
   * The background tasks themselves, oldest first — what each one is and how
   * long it has been going.
   *
   * `backgroundCount` stays the authoritative number; this list is capped, so a
   * session that fires twenty of them does not put twenty descriptions in a
   * column every snapshot rewrites.
   */
  backgroundTasks?: { id: string; description: string; elapsedSec: number }[];
};

/** The first line of whatever identifies this tool call, capped for a chip. */
function detailOf(name: string, input: unknown): string | null {
  const i = input as Record<string, unknown> | null | undefined;
  if (!i || typeof i !== 'object') return null;
  const raw =
    (typeof i.command === 'string' && i.command) ||
    (typeof i.file_path === 'string' && i.file_path) ||
    (typeof i.pattern === 'string' && i.pattern) ||
    (typeof i.description === 'string' && i.description) ||
    (typeof i.url === 'string' && i.url) ||
    (typeof i.prompt === 'string' && i.prompt) ||
    null;
  if (!raw) return null;
  const line = raw.split('\n')[0].trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * Fold one SDK message into the state. Returns nothing — the caller owns the
 * state object, so a session's tracker is just a field on its handle.
 *
 * `nowMs` is passed rather than read so the tests can drive a clock.
 */
export function applyActivityMessage(st: ActivityState, msg: unknown, nowMs: number): void {
  const m = msg as any;
  if (!m || typeof m !== 'object') return;

  // A tool starts when the assistant emits its `tool_use` block…
  if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content) {
      if (b?.type !== 'tool_use' || !b.id) continue;
      st.tools.set(b.id, {
        toolUseId: b.id,
        name: typeof b.name === 'string' ? b.name : 'tool',
        detail: detailOf(b.name, b.input),
        startedAtMs: nowMs,
        parentToolUseId: m.parent_tool_use_id ?? null,
      });
    }
    // Any assistant frame means the model answered, so a retry is over.
    st.retry = null;
    return;
  }

  // …and ends when its result comes back.
  if (m.type === 'user' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content) {
      if (b?.type === 'tool_result' && b.tool_use_id) st.tools.delete(b.tool_use_id);
    }
    return;
  }

  if (m.type === 'tool_progress' && m.tool_use_id) {
    const t = st.tools.get(m.tool_use_id);
    if (t && typeof m.elapsed_time_seconds === 'number') t.reportedElapsedSec = m.elapsed_time_seconds;
    return;
  }

  if (m.type === 'system') {
    // The turn boundary. Measured against 2.1.238: `running` arrives ahead of
    // the turn's `init` frame — including for turns nothing submitted, such as
    // the re-invocation that follows a background task completing — and `idle`
    // lands immediately after that turn's `result`, or after an interrupt's
    // `error_during_execution`. The one signal here that describes a whole turn
    // rather than a slice of one.
    if (m.subtype === 'session_state_changed') {
      if (m.state === 'idle' || m.state === 'running' || m.state === 'requires_action') {
        st.sessionState = m.state;
      }
      return;
    }
    if (m.subtype === 'status') {
      st.status = m.status === 'requesting' || m.status === 'compacting' ? m.status : null;
      return;
    }
    if (m.subtype === 'api_retry') {
      st.retry = {
        attempt: Number(m.attempt) || 0,
        maxRetries: Number(m.max_retries) || 0,
        delayMs: Number(m.retry_delay_ms) || 0,
        atMs: nowMs,
      };
      return;
    }
    if (m.subtype === 'task_started' && m.task_id) {
      st.tasks.set(m.task_id, {
        description: typeof m.description === 'string' ? m.description : 'task',
        subagentType: m.subagent_type,
      });
      return;
    }
    if ((m.subtype === 'task_progress' || m.subtype === 'task_updated') && m.task_id) {
      const t: { description: string; subagentType?: string; lastTool?: string } =
        st.tasks.get(m.task_id) ?? { description: String(m.description ?? 'task') };
      if (typeof m.description === 'string') t.description = m.description;
      if (typeof m.last_tool_name === 'string') t.lastTool = m.last_tool_name;
      if (typeof m.subagent_type === 'string') t.subagentType = m.subagent_type;
      st.tasks.set(m.task_id, t);
      return;
    }
    if (m.subtype === 'task_notification' && m.task_id) {
      st.tasks.delete(m.task_id);
      return;
    }
    if (m.subtype === 'background_tasks_changed') {
      // REPLACE semantics: the payload is every live background task. Rebuilt
      // rather than mutated so a task that vanished is gone — but carried over
      // by id, so `startedAtMs` is when the task started and not when the CLI
      // last happened to mention it. A description is likewise kept when a later
      // frame omits it; losing the only human-readable name for a task because
      // one frame was terse would be the worst kind of flicker.
      const next = new Map<string, BackgroundTask>();
      for (const t of Array.isArray(m.tasks) ? m.tasks : []) {
        const id = String((t as any)?.task_id ?? '');
        if (!id) continue;
        const prev = st.background.get(id);
        const desc = String((t as any)?.description ?? '').trim();
        next.set(id, {
          taskId: id,
          description: desc || prev?.description || '',
          startedAtMs: prev?.startedAtMs ?? nowMs,
        });
      }
      st.background = next;
      return;
    }
    return;
  }

  // A turn ended: nothing of this turn is still running.
  //
  // `sessionState` is deliberately NOT cleared here. Its `idle` frame arrives
  // AFTER the result, so zeroing it on the result would blind us for exactly the
  // window that matters — and a result is not even reliable evidence the work is
  // over: the CLI emits one per inner turn and then re-invokes the model when a
  // background task lands. `background` is left alone for the same reason (that
  // work outlives the turn that started it).
  if (m.type === 'result') {
    st.tools.clear();
    st.tasks.clear();
    st.status = null;
    st.retry = null;
  }
}

/** Whole seconds a tool has been running, preferring the CLI's own number. */
export function elapsedSecOf(t: RunningTool, nowMs: number): number {
  return t.reportedElapsedSec ?? Math.max(0, Math.floor((nowMs - t.startedAtMs) / 1000));
}

/**
 * The single thing worth showing, or null when the session is idle.
 *
 * Ordered by what a person most needs to know. A rate limit outranks everything
 * — it is the difference between "slow" and "stuck", and it is the one state the
 * pane could not report at all, so a limited session just looked hung.
 */
export function describeActivity(st: ActivityState, nowMs: number): RuntimeActivity | null {
  // Oldest first: the one that has been running longest is the one worth naming
  // and the one most likely to be stuck.
  const bg = [...st.background.values()].sort((a, b) => a.startedAtMs - b.startedAtMs);
  const backgroundCount = bg.length || undefined;
  const backgroundTasks = bg.length
    ? bg.slice(0, BACKGROUND_LIST_CAP).map((t) => ({
        id: t.taskId,
        description: t.description || 'background task',
        elapsedSec: Math.max(0, Math.floor((nowMs - t.startedAtMs) / 1000)),
      }))
    : undefined;

  if (st.retry) {
    const waited = nowMs - st.retry.atMs;
    const left = Math.max(0, Math.ceil((st.retry.delayMs - waited) / 1000));
    return {
      kind: 'retrying',
      label: 'retrying',
      detail: `API retry ${st.retry.attempt}/${st.retry.maxRetries}`,
      attempt: st.retry.attempt,
      maxRetries: st.retry.maxRetries,
      retryInSec: left,
      backgroundCount,
      backgroundTasks,
    };
  }

  if (st.status === 'compacting') {
    return { kind: 'compacting', label: 'compacting', detail: 'summarising the conversation', backgroundCount, backgroundTasks };
  }

  // A subagent outranks its own inner tool: "which subagent" is the useful
  // altitude, and the tool it happens to be on is the qualifier.
  const task = [...st.tasks.values()][0];
  if (task) {
    return {
      kind: 'subagent',
      label: task.subagentType ?? 'subagent',
      detail: [task.description, task.lastTool].filter(Boolean).join(' · ') || undefined,
      backgroundCount,
      backgroundTasks,
    };
  }

  // The longest-running foreground tool. Longest, not newest: when several are
  // in flight the one holding the turn up is the one worth naming.
  const foreground = [...st.tools.values()].filter((t) => !t.parentToolUseId);
  if (foreground.length > 0) {
    const t = foreground.reduce((a, b) => (a.startedAtMs <= b.startedAtMs ? a : b));
    return {
      kind: 'tool',
      label: t.name,
      detail: t.detail ?? undefined,
      elapsedSec: elapsedSecOf(t, nowMs),
      backgroundCount,
      backgroundTasks,
    };
  }

  if (st.status === 'requesting') {
    return { kind: 'thinking', label: 'thinking', backgroundCount, backgroundTasks };
  }

  // Nothing in the foreground, but work is still going on somewhere.
  if (backgroundCount) {
    return {
      kind: 'background',
      label: 'background',
      detail: backgroundTasks?.[0]?.description || undefined,
      // The age of the OLDEST task, so the chip reads "background · 1h 28m"
      // rather than a bare "background" that says the same thing at 3 seconds
      // and at three hours.
      elapsedSec: backgroundTasks?.[0]?.elapsedSec,
      backgroundCount,
      backgroundTasks,
    };
  }

  return null;
}

/**
 * Foreground Bash calls that have outlived `afterMs`.
 *
 * The rescue list for the long-command watchdog — see claude-sdk.ts. Restricted
 * to Bash on purpose: backgrounding a subagent mid-run is a bigger surprise than
 * backgrounding a shell command, and a wedged shell is the case this exists for.
 */
export function bashesRunningLongerThan(st: ActivityState, afterMs: number, nowMs: number): RunningTool[] {
  return [...st.tools.values()].filter(
    (t) => t.name === 'Bash' && !t.parentToolUseId && nowMs - t.startedAtMs >= afterMs,
  );
}
