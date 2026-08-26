// One cron fire, on whichever backend the dashboard resolved for it.
//
// cron-runner has always had exactly two ways to fire a job: a throwaway tmux
// pane running Claude Code, and a bespoke one-shot `codex exec`. Everything else
// fell through an `else` into the pane — so a cron whose session ran on pi+Kimi
// or dsh+OpenRouter quietly ran on the Claude subscription instead, and the only
// way to notice was to read the transcript. This is the missing third way: drive
// the backend through the same `AgentRuntime` contract chat-runner uses, so a
// backend a user can PICK is a backend a cron can RUN ON.
//
// Deliberately NOT a session. A cron fire is one turn with no history, no
// resume, and no row in the dashboard's ChatSession table — `ensure()` is handed
// a synthetic id, its emitted sync items are collected here instead of being
// POSTed, and the handle is killed on the way out however the turn ended. The
// chat path's coalescing, replay-dedupe and transcript backstop are all about
// keeping a LIVE conversation consistent, and none of them apply to something
// that is torn down sixty seconds later.
//
// claude-tmux stays on the pane path in cron-runner: it is not an AgentRuntime
// (runtimeFor returns null for it) and its cron path carries drift-adoption
// machinery this cannot replicate. See docs/cron-backends.md.

import { extractText } from '../claude-code';
import { runtimeFor } from './index';
import type { AgentRuntime, SyncItem } from './types';

/**
 * How long to let a backend get started before "not working" counts as done.
 *
 * Deliberately generous, because the two ways to be wrong here are not equally
 * bad. Wait too long on a backend that will never speak and a dead cron takes
 * two minutes to be declared dead — it was going to fail either way. Settle too
 * early and a HEALTHY cron is reported as `no_output` while its turn is still
 * running, which is a lie about working software and sends someone to read logs
 * that say nothing is wrong.
 *
 * The window is real: pi, omp and prime answer `isWorking` with a round-trip
 * `get_state`, and `submit` only awaits the RPC ack — "a model turn is NOT a
 * request; prompt acks immediately" (runtime/jsonl-transport.ts). So there is a
 * stretch after submit returns where the child has the prompt and has not yet
 * flipped `isStreaming`, and during it an idle reading means nothing.
 */
const START_GRACE_MS = 120_000;

export type CronTurnOutcome = {
  /** Final assistant text of the turn, trimmed. Empty if it never said anything. */
  text: string;
  /**
   * Did the turn go genuinely idle, rather than fall through the deadline?
   * Feeds cron-runner's classifyRun — settled+empty is `no_output`, and never
   * settling is `timeout`, which is NOT a failure (see classifyRun).
   */
  settled: boolean;
  /**
   * What the backend said went wrong, if anything — its `system` messages,
   * joined.
   *
   * This is the difference between a cron that reports "auth expired" and one
   * that reports nothing at all. No runtime here THROWS on an expired login, a
   * spent quota or a dead child: pi/omp/prime turn a failed turn into a
   * `[pi error — the turn did not complete]` system row (runtime/pi-events.ts),
   * dsh into `[dsh could not run this turn]` with the stderr tail, claude-sdk
   * into `[gateway] ⚠️ 这一轮没有正常结束：…`. All of them then produce no
   * assistant text and return normally. Collect only assistant text and every
   * one of those failures is indistinguishable from a quiet success.
   *
   * Reported whether or not it looks like a failure — see `harnessFailed`.
   */
  harnessNote: string;
  /**
   * Did any of those notes actually report a failure (isFailureNote)?
   *
   * Separate from `harnessNote` because the two questions are different: what to
   * SHOW the reader, and what STATUS to give the run. A background-task notice
   * belongs in the report and must not turn it red.
   */
  harnessFailed: boolean;
};

export type CronTurnOpts = {
  /** The HARNESS to spawn, already resolved by the dashboard (not a backend id). */
  harness: string;
  /** pi spawn recipe; null for every other harness. */
  mode: string | null;
  agentName: string;
  cwd: string;
  prompt: string;
  /** Throwaway session id for this fire — never a real ChatSession id. */
  sessionId: string;
  credentialId: string | null;
  provider: string | null;
  model: string | null;
  isOrchestrator: boolean;
  /** Hard cap for the whole turn. */
  timeoutMs: number;
  /** Idle this long after the backend stops working ⇒ the turn is complete. */
  idleMs: number;
  /**
   * The backend's own session id, as soon as it exists.
   *
   * claude-sdk writes its transcript into the SAME ~/.claude/projects/<cwd> dir
   * the agent's chats use, so a fire on that backend has to be registered as
   * cron-owned or a chat mid-`--resume` can sniff the dir, land on the cron's
   * transcript and answer the user with the cron's report (macmini002,
   * 2026-08-13 — see cron-uuids.ts). Reported rather than held here because
   * ownership is cron-runner's bookkeeping, not a runtime's.
   */
  onStarted?: (externalSessionId: string) => void;
  /** Injected in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The backend to drive, instead of looking one up by harness.
   *
   * A test seam, and the only one: the settle loop below is the part of this
   * module that can be subtly wrong in a way no typecheck catches — settling one
   * poll too early reports a working cron as `no_output` — and it cannot be
   * exercised at all without a backend whose isWorking a test controls.
   */
  runtime?: AgentRuntime;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Is this harness one this module can drive?
 *
 * `runtimeFor` answering null means "claude-tmux, or something this gateway does
 * not know" — both of which belong on cron-runner's pane path, which is also the
 * behaviour every cron had before backends existed.
 */
export function canRunCronTurn(harness: string | null | undefined, mode: string | null): boolean {
  return runtimeFor(harness, mode) !== null;
}

/**
 * Does this system message report a FAILURE, as opposed to routine narration?
 *
 * Not every `system` row is bad news. claude-sdk alone emits at least three
 * routine ones — a background-task notice (`⏱️ …已转入后台，这一轮继续`), a
 * compaction boundary (`🗜️ 上下文已自动压缩`), and `local_command_output`, which
 * is just a fenced block of command output. Treating any of them as a failure
 * turns an ordinary tool-only turn into a red `error` and a failure push, which
 * is its own kind of lying about working software.
 *
 * Matching on prose is not where this belongs — the right home is a typed flag
 * on SyncItem, set by each runtime where it already knows the turn failed. That
 * is a change across pi-events / dsh-events / claude-sdk-events and their
 * dashboard consumers, so it is written down in docs/cron-backends.md rather
 * than smuggled in here. What makes the interim safe is that the note is
 * reported EITHER WAY: an unrecognised failure still reaches the reader as text,
 * it just does not colour the status. Today it reaches them as nothing at all.
 */
export function isFailureNote(text: string): boolean {
  return /^\s*\[(?:gateway\]\s*⚠️|turn interrupted|pi error|pi could not start|pi session ended|pi is on the wrong provider|omp session ended|omp could not start|Prime Agent could not start|prime session ended|dsh could not run this turn|dsh —)/i.test(
    text,
  );
}

export async function runRuntimeCronTurn(opts: CronTurnOpts): Promise<CronTurnOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const runtime = opts.runtime ?? runtimeFor(opts.harness, opts.mode);
  // Callers gate on canRunCronTurn; this is the guard that makes the type safe
  // and turns a routing mistake into a named error instead of a crash.
  if (!runtime) throw new Error(`[cron-turn] no runtime for harness "${opts.harness}"`);

  // The turn's answer, kept the same way the pane path keeps it: the LATEST
  // assistant text wins, because an agent that writes a report and then adds a
  // sign-off should be reported by the sign-off's message, not the first thing
  // it said.
  //
  // `transient` items are the streaming placeholder — the growing bubble a chat
  // renders while a block arrives — and `deleted` items retract it. Both are
  // artefacts of live rendering; taking either as the answer would report a
  // half-written sentence as the cron's result.
  let lastText = '';
  // Every system line, in order, deduped. Deduped because a backend can repeat
  // the same complaint each poll, and a run that failed once should not report
  // the same sentence forty times; kept in full rather than last-only because a
  // boot failure followed by a session-ended notice are two different facts and
  // the reader needs both.
  const notes: string[] = [];
  let failed = false;
  // Set once the settle loop owns the clock; before that there is nothing to
  // bump. Every emitted item counts as a sign of life — see the settle comment.
  let bumpActive: () => void = () => {};
  const collect = (item: SyncItem) => {
    if (item.transient || item.deleted) return;
    bumpActive();
    const t = extractText(item.content).trim();
    if (!t) return;
    if (item.role === 'assistant') {
      lastText = t;
      return;
    }
    // 'system' is where every backend puts what went wrong. 'user' items are
    // tool results echoing back and are not ours to report.
    if (item.role !== 'system' || notes.includes(t)) return;
    notes.push(t);
    if (isFailureNote(t)) failed = true;
  };

  const startedAt = now();
  const deadline = startedAt + opts.timeoutMs;
  const handle = await runtime.ensure(
    {
      id: opts.sessionId,
      agentName: opts.agentName,
      agentDirectory: opts.cwd,
      // Always a fresh turn: a cron carries no conversation between fires, and
      // handing a resume id we do not have would make the backend hunt for a
      // transcript that was never written.
      externalSessionId: null,
      provider: opts.provider,
      model: opts.model,
      mode: opts.mode,
      credentialId: opts.credentialId,
      isOrchestrator: opts.isOrchestrator,
      // Exactly the pane path's rule (cron-runner → cronPaneEnv): the
      // orchestrator's crons need the hermit/brain tools to do their job, and an
      // ordinary headless cron has no consumer for the machine key — its
      // throwaway session id has no ChatSession row for those tools to act on,
      // so they would 404 while the credential sat in every tool subprocess.
      hermitTools: opts.isOrchestrator,
    },
    collect,
  );
  if (handle.externalSessionId) opts.onStarted?.(handle.externalSessionId);

  const note = () => notes.join('\n\n');
  try {
    const ok = await runtime.submit(handle, opts.prompt, []);
    // A refused submit is an ERROR, not an empty turn — "no_output" would send
    // the reader to the agent's own logs, a wasted hour when the real answer is
    // that the backend never accepted the prompt.
    //
    // Returned rather than thrown, because pi/omp/prime return false for a dead
    // child and emit the REASON as a system row on the way (`[pi session ended
    // — …]`). Throwing here would replace that reason with this sentence, which
    // says only that something went wrong, not what.
    if (!ok) {
      return {
        text: lastText.trim(),
        settled: true,
        harnessNote: note() || `${runtime.kind} refused the prompt (submit returned false)`,
        // A refused submit IS a failure, whatever the backend did or did not say.
        harnessFailed: true,
      };
    }

    // ── Settle ───────────────────────────────────────────────────────────────
    //
    // `isWorking` is the backend's own answer, so unlike the pane path there is
    // no spinner to scrape. The one hazard it brings is the opposite of the
    // pane's: isWorking can read false in the moment BETWEEN submit returning
    // and the child actually picking the turn up, which would settle the run
    // instantly and report a perfectly good cron as `no_output`.
    //
    // Three guards, and the first two are the ones that took a review to find:
    //
    //  • `lastActiveAt` counts ANY sign of life, not just a busy reading —
    //    `collect` bumps it on every item the backend emits. Anchoring it to the
    //    start instead meant that the moment a backend said anything at all
    //    (which disarms the grace, below), `now() - lastActiveAt` was already
    //    the whole elapsed run, so the very next poll past idleMs settled: a pi
    //    turn that printed "starting the audit…" and then worked for ten minutes
    //    was cut off at nine seconds and its preamble filed as the report. This
    //    mirrors the pane path, where every transcript line bumps lastEventAt.
    //
    //  • the grace runs from `submittedAt`, sampled after ensure+submit, not
    //    from the top of the fire. `ensure` spawns a child and, for pi, reads
    //    the encrypted secret store through subprocesses first — on a loaded
    //    machine that is tens of seconds, all of which used to be deducted from
    //    the window meant to cover the backend's first token.
    //
    //  • `sawWorking`: a turn we watched start is only finished once we have
    //    also watched it stop.
    let sawWorking = false;
    const submittedAt = now();
    let lastActiveAt = submittedAt;
    bumpActive = () => { lastActiveAt = now(); };
    let settled = false;
    while (now() < deadline) {
      await sleep(1_000);
      if (await runtime.isWorking(handle)) {
        sawWorking = true;
        lastActiveAt = now();
        continue;
      }
      // Idle, but possibly not yet started: hold until either we have seen it
      // work, it has said something, or the grace window closes. Without this a
      // slow-spawning backend reports no_output before it has drawn breath.
      if (!sawWorking && !lastText && now() - submittedAt < START_GRACE_MS) continue;
      if (now() - lastActiveAt > opts.idleMs) {
        settled = true;
        break;
      }
    }
    return { text: lastText.trim(), settled, harnessNote: note(), harnessFailed: failed };
  } finally {
    // 'kill', never 'hibernate': this session has no future. Hibernating would
    // leave a resumable child and a durable entry per fire, and a cron that runs
    // every ten minutes would accumulate them forever.
    await runtime.stop(handle, 'kill').catch(() => {});
  }
}
