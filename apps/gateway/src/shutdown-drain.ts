// shutdown-drain.ts — what a restart owes the sessions this gateway is holding.
//
// Until this existed, `shutdown()` was a synchronous function ending in
// `process.exit(0)`: no await anywhere in it, so the drain window was zero
// seconds. Every claude-sdk session on the box lost its in-flight turn, and the
// interrupted tool call went into the transcript looking like a call the USER
// had rejected. Worse, six of the seven backends were never told at all —
// `shutdown()` closed claude-sdk and the chat runner, and left codex, kimi, dsh,
// pi, omp and prime to either notice their own stdin closing (pi/omp/prime, by
// luck rather than design) or carry on as orphans writing to a session file the
// NEXT gateway is about to resume from (kimi and dsh, which have no writer lock
// to make that collision loud).
//
// So the order on the way down is: stop taking new work → give the turns that
// are running a real chance to finish → tell the ones that don't → interrupt
// them so the transcript records an honest interruption → close every child.
//
// Two things this deliberately does NOT do:
//   • wait indefinitely. A turn can be ten minutes long; a restart cannot be.
//     The budget is what pm2 is willing to wait (`kill_timeout`) minus room for
//     the flush, and anything still running when it expires is cut — but cut
//     LOUDLY, with a row in the conversation, rather than in silence.
//   • assume the drain is why the child dies. `stop()` is still called for every
//     held session afterwards, including the ones that finished on their own,
//     because "the turn ended" is not "the process is gone".
//
// Pure of I/O by construction — clock, sleep, logging and the notice POST are
// all injected — because the one thing that must never happen here is a bug
// that only shows up while the process is on its way out, where no test runs
// and no one is watching.

/** The slice of AgentRuntime the drain needs. Structural, so tests need no stubs of the rest. */
export interface DrainRuntime {
  readonly kind: string;
  liveSessionIds(): string[];
  isWorking(handle: { sessionId: string; externalSessionId: string }): Promise<boolean>;
  interrupt(handle: { sessionId: string; externalSessionId: string }): Promise<void>;
  stop(handle: { sessionId: string; externalSessionId: string }, mode: 'hibernate' | 'kill'): Promise<void>;
}

export interface DrainDeps {
  runtimes: DrainRuntime[];
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Post one system row into a conversation. Must resolve even on failure. */
  postNotice(sessionId: string, externalId: string, text: string): Promise<void>;
  log(line: string): void;
}

export interface DrainOptions {
  /** How long turns may keep running before they are cut. */
  budgetMs: number;
  /** How often to re-ask "is anyone still working?". */
  pollMs?: number;
  /** How long to let an interrupt land before closing the child under it. */
  interruptGraceMs?: number;
  /**
   * How long the "your turn was cut" notices may take before the shutdown moves
   * on without them. The watchdog restarts a gateway exactly when its dashboard
   * client has wedged, so this path's most likely caller is one whose POSTs all
   * hang; the notice is the nice-to-have, the shutdown is not.
   */
  noticeBudgetMs?: number;
  /** Cap on the interrupt phase and on the close-every-child phase, each. */
  phaseBudgetMs?: number;
  /** Stamp for the notice's externalId, so a retry collapses onto one row. */
  stampMs: number;
}

export interface DrainReport {
  /** Sessions held by any backend when the drain started. */
  held: number;
  /** Of those, how many had a turn in flight. */
  busy: number;
  /** Turns that finished inside the budget. */
  finished: number;
  /** Turns still running when the budget expired. */
  cut: number;
  /**
   * Which sessions those were.
   *
   * The caller records them so the NEXT gateway can pick them back up. It has
   * to come from here rather than from the turn-boundary tracker, because
   * `interrupt()` below announces the session as idle — truthfully, but that
   * would erase the very list we need — and because a turn that finished during
   * the wait must not be resumed as if it had been cut.
   */
  cutSessionIds: string[];
  /** How long the wait actually took. */
  waitedMs: number;
}

/** The text a cut session gets. Exported so the test asserts on the real string. */
export const CUT_NOTICE =
  '[gateway] ⚠️ 网关重启，这一轮被打断了。对话历史已保存，网关起来后会自动接回来继续；' +
  '如果没有自动继续，再发一条消息就能接着聊。';

interface Entry {
  rt: DrainRuntime;
  sessionId: string;
}

function handle(sessionId: string) {
  // externalSessionId is unused by every stop/interrupt/isWorking path — they
  // all look the session up by id in their own live map — and at shutdown we do
  // not have it. Same shape the restart and hibernate paths already pass.
  return { sessionId, externalSessionId: '' };
}

/**
 * Run `work`, but never let it hold the shutdown past `budgetMs`.
 *
 * Every phase below is an RPC to a child that may be the reason we are
 * restarting in the first place — a wedged CLI does not answer `interrupt()`
 * any faster than it answers anything else. Unbounded, the phases add up past
 * pm2's kill_timeout and the process is SIGKILLed mid-drain, which is the exact
 * behaviour this file replaces.
 */
async function withDeadline(deps: DrainDeps, budgetMs: number, what: string, work: Promise<unknown>): Promise<void> {
  let done = false;
  await Promise.race([work.then(() => { done = true; }), deps.sleep(budgetMs)]);
  if (!done) deps.log(`[shutdown] ${what} did not finish in ${budgetMs}ms — moving on`);
}

/** Never let one backend's bug stop the others from being told. */
async function guarded<T>(what: string, deps: DrainDeps, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    deps.log(`[shutdown] ${what} failed: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

export async function drainSessions(deps: DrainDeps, opts: DrainOptions): Promise<DrainReport> {
  const pollMs = opts.pollMs ?? 250;
  const graceMs = opts.interruptGraceMs ?? 1_500;
  const startedAt = deps.now();

  const entries: Entry[] = [];
  for (const rt of deps.runtimes) {
    let ids: string[] = [];
    try {
      ids = rt.liveSessionIds();
    } catch (e) {
      deps.log(`[shutdown] ${rt.kind} could not list its sessions: ${(e as Error)?.message ?? e}`);
    }
    for (const sessionId of ids) entries.push({ rt, sessionId });
  }

  if (entries.length === 0) {
    return { held: 0, busy: 0, finished: 0, cut: 0, cutSessionIds: [], waitedMs: 0 };
  }

  // A backend that cannot answer is treated as idle. The alternative — assuming
  // it is busy — would hold the whole restart open for the full budget on one
  // broken backend, which is the failure mode nobody would debug at 3am.
  const stillWorking = async (): Promise<Entry[]> => {
    const flags = await Promise.all(entries.map((e) =>
      guarded(`${e.rt.kind} isWorking`, deps, () => e.rt.isWorking(handle(e.sessionId)))));
    return entries.filter((_, i) => flags[i] === true);
  };

  let busy = await stillWorking();
  const busyAtStart = busy.length;
  const deadline = startedAt + opts.budgetMs;
  while (busy.length > 0 && deps.now() < deadline) {
    deps.log(`[shutdown] waiting for ${busy.length} turn(s) to finish`);
    await deps.sleep(Math.min(pollMs, Math.max(0, deadline - deps.now())));
    busy = await stillWorking();
  }

  const waitedMs = deps.now() - startedAt;

  // Tell them, THEN interrupt. The other order races: an interrupt can end the
  // turn and take the session's own "[turn interrupted]" row through the same
  // sync buffer, and the reason the user actually needs — that a restart did
  // this, not the model and not them — would arrive second or not at all.
  //
  // In parallel and under a deadline, because of WHEN this runs: the watchdog
  // restarts a gateway precisely when its dashboard HTTP client has wedged, so
  // the most likely caller is one whose POSTs all hang. Sequential awaits with
  // no bound would spend N × the client timeout here and get SIGKILLed before
  // closing a single child — the notice is the nice-to-have, and the shutdown
  // is not.
  if (busy.length > 0) {
    await withDeadline(deps, opts.noticeBudgetMs ?? 4_000, 'cut notices (the dashboard is not answering)',
      Promise.all(busy.map((e) =>
        guarded(`${e.rt.kind} notice`, deps, () =>
          deps.postNotice(e.sessionId, `shutdown-${e.sessionId}-${opts.stampMs}`, CUT_NOTICE)))));
    await withDeadline(deps, opts.phaseBudgetMs ?? 3_000, 'interrupts',
      Promise.all(busy.map((e) =>
        guarded(`${e.rt.kind} interrupt`, deps, () => e.rt.interrupt(handle(e.sessionId))))));
    await deps.sleep(graceMs);
  }

  // Every held session, not just the busy ones: an idle child is still a child,
  // and `hibernate` is the mode that says "the transcript is the durable state,
  // come back to it" rather than "this session is over".
  await withDeadline(deps, opts.phaseBudgetMs ?? 3_000, 'closing the children',
    Promise.all(entries.map((e) =>
      guarded(`${e.rt.kind} stop`, deps, () => e.rt.stop(handle(e.sessionId), 'hibernate')))));

  const report: DrainReport = {
    held: entries.length,
    busy: busyAtStart,
    finished: busyAtStart - busy.length,
    cut: busy.length,
    cutSessionIds: busy.map((e) => e.sessionId),
    waitedMs,
  };
  deps.log(
    `[shutdown] ${report.held} session(s) held · ${report.busy} mid-turn · ` +
    `${report.finished} finished in ${(report.waitedMs / 1000).toFixed(1)}s · ${report.cut} cut`,
  );
  return report;
}
