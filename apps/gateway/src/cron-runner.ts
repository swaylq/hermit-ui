// cron-runner.ts — fire Cron jobs as fresh, throwaway turns in the agent dir.
//
// Each fire is isolated: no session reuse, no history, torn down when it
// replies. WHICH backend runs it is resolved by the dashboard, per cron, exactly
// as it is for a chat session — see docs/cron-backends.md for the three fire
// paths and why they are not one. The pane path below (claude-tmux, and any
// harness this gateway does not recognise) is the original: an interactive
// `claude` in a throwaway tmux pane, tailing the JSONL transcript for the
// assistant turn. NO happy, NO `claude -p`.
//
// Scheduling is interval + jitter (1b): nextFire = lastFire + intervalSec ±
// random(jitterSec). The dashboard is the source of truth for `nextFire`; the
// gateway writes it back on each fire so a gateway restart resumes cleanly.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  ensureSession,
  sendKeys,
  awaitTranscript,
  watchTranscript,
  resolveLiveTranscript,
  encodedProjectDir,
  kill as killSession,
  type TranscriptInfo,
} from '@hermit-ui/tmux-driver';
import { AGENTS_ROOT, ASST_KEY, DASHBOARD_URL } from './config';
import { api } from './api';
import { paneIsWorking } from './pane';
import { extractText, CcEvent, CcBlock } from './claude-code';
import { buildMcpConfigArg, chatOwnedUuids } from './chat-runner';
import { holdCronUuid, releaseCronUuid, cronOwnedUuids } from './cron-uuids';
import { runCodexCronTurn } from './runtime/codex-exec';
import { canRunCronTurn, runRuntimeCronTurn } from './runtime/cron-turn';
import { tryAcquire, release, isLocked } from './op-locks';

const RUN_TIMEOUT_MS = 120 * 60_000; // hard cap per run (2h)
const IDLE_DONE_MS = 8_000;         // assistant quiet this long ⇒ turn complete
// Cap on the output shipped to the dashboard. CronRun.output is @db.Text and the sync
// route sets no bound of its own, so this number is the only limit in the path — and at
// 4096 it was cutting ordinary daily reports in half (2026-08-10: a 14,101-char report
// arrived starting mid-sentence). 32K fits any report a cron should be writing while
// still bounding a runaway turn that dumps a whole file into its final message.
const OUTPUT_MAX = 32_768;
// How long to wait for the PINNED transcript before declaring drift. awaitTranscript's
// 30s default is a coin flip on a box running 20+ claude processes: on 2026-08-09 the
// file appeared at ~31s, one second past the deadline, and the fire went down the
// drift-adopt path for no reason. Waiting longer is nearly free — the prompt isn't sent
// until this resolves either way, and the run's own cap is RUN_TIMEOUT_MS (2h).
const TRANSCRIPT_WAIT_MS = 90_000;

type Cron = {
  id: string;
  agentName: string;
  agentDirectory: string | null;
  isOrchestrator?: boolean;
  directory: string | null;
  prompt: string;
  intervalSec: number;
  jitterSec: number;
  enabled: boolean;
  lastFire: string | null;
  nextFire: string | null;
  /**
   * Which backend fires this cron, resolved by the dashboard
   * (cron.listForGateway → resolveRuntime): the report session's own choice,
   * else the agent's default, else the floor — the same chain chat resolves.
   * Absent on an older dashboard → the pane path, which is what every cron did
   * before this field existed.
   *
   * `runtime` is the HARNESS to spawn. The four below are what authenticates it
   * and what it runs as; a custom backend is a harness PLUS a credential, so a
   * harness on its own is not enough to fire one — sending only `runtime` is
   * exactly why a pi+Kimi cron used to land on Claude.
   */
  runtime?: string | null;
  /** The backend id the user actually picked, for logs. */
  backendId?: string | null;
  runtimeCredentialId?: string | null;
  runtimeProvider?: string | null;
  runtimeModel?: string | null;
  /** pi spawn recipe; null for every other harness. */
  runtimeMode?: string | null;
};

/** Environment inherited by one Claude cron pane. Hermit credentials exist
 * only when the same branch installs the hermit/Brain MCP that consumes them. */
export function cronPaneEnv(isOrchestrator: boolean, runSessionId: string): Record<string, string> {
  return {
    ...(isOrchestrator ? {
      HERMIT_DASHBOARD_URL: DASHBOARD_URL,
      HERMIT_KEY: ASST_KEY,
      HERMIT_SESSION_ID: runSessionId,
    } : {}),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // A cron fire, not a conversation — read by the fleet's Stop hooks, which
    // must not force a follow-up reply here: the LAST assistant message is what
    // this fire reports. See RuntimeSession.isCron.
    HERMIT_CRON: '1',
  };
}

// The per-cron re-entrancy guard ('cron' lock, keyed by cronId) lives in the shared
// op-locks owner (./op-locks): a cron must not fire again while its previous run is
// still in flight (a run can take up to RUN_TIMEOUT_MS = 2h; the tick re-checks each
// interval and skips a cron already running).
// claude-session uuids pinned by an in-flight fire — so the uuid-drift self-heal
// never adopts a SIBLING cron's live transcript (agents share one project dir).
// The registry lives in ./cron-uuids because the CHAT runner has to read it too;
// see the note there for why both directions are needed.

// Which transcript should a fire adopt when its pinned one never appeared? The newest
// transcript written at/after the fire started that NOBODY ELSE owns:
//   • pinned    — uuids held by in-flight sibling crons in this process;
//   • chatOwned — uuids held by the agent's dashboard CHAT sessions.
// An agent's crons and its chats share ONE project dir. Only `pinned` was excluded until
// 2026-08-09, and a chat that is mid-turn is by construction the newest file in that dir
// — so a late-pinned cron adopted the live chat every time and reported the chat's last
// assistant message as its own result. Genuine drift still heals: a claude that ignored
// `--session-id` writes a transcript nobody owns, which is exactly what's left here.
// Exported for cron-runner.test.ts.
export function adoptDriftTranscript(
  cwd: string,
  opts: { pinned: ReadonlySet<string>; chatOwned: ReadonlySet<string>; minMtimeMs: number },
): TranscriptInfo | null {
  return resolveLiveTranscript(cwd, {
    exclude: new Set([...opts.pinned, ...opts.chatOwned]),
    minMtimeMs: opts.minMtimeMs,
  });
}

// Cap the run's output for the dashboard, and SAY SO when it doesn't fit.
//
// Two things were wrong with the old `output.slice(-OUTPUT_TAIL)`:
//   • it kept the wrong end. A cron's output is the agent's final message, and every
//     instruction we give cron authors says to LEAD with the outcome (see the
//     cron_create tool description). Keeping the tail therefore drops the headline and
//     keeps the sign-off — the reader gets a report starting mid-sentence.
//   • it was SILENT. Nothing in the delivered message said anything had been removed,
//     so a truncated report is indistinguishable from a cron that failed to write one.
//     That is the part that actually costs you a morning: on 2026-08-10 a 14,101-char
//     daily report lost its first 10K characters and read as "the report never ran".
// The marker is appended past `max` on purpose — it is the one line that must survive,
// and the column it lands in is unbounded (@db.Text).
export function capOutput(output: string, max: number, transcriptPath?: string): string {
  if (output.length <= max) return output;
  const dropped = output.length - max;
  return (
    output.slice(0, max) +
    `\n\n[cron-runner] ⚠️ output truncated — kept the first ${max.toLocaleString()} of ` +
    `${output.length.toLocaleString()} characters (${dropped.toLocaleString()} dropped).` +
    (transcriptPath ? ` Full text: ${transcriptPath}` : '')
  );
}

// ── Run markers: a cron that ends itself, or re-paces itself ─────────────────
//
// A run may close its reply with ONE of two protocol lines (see the `cron` skill,
// apps/cli/template/.claude/skills/cron/SKILL.md):
//
//   CRON_DONE            the goal is reached — stop firing (the dashboard stamps
//                        doneAt and disables the cron, so /cron says 已完成 rather
//                        than 已暂停)
//   CRON_NEXT <minutes>  re-pace: run again in that many minutes instead of the
//                        stored interval ("自调步")
//
// This is what replaced the session-scoped loop: iterate-until-done and
// pick-your-own-cadence now live on a durable cron instead of a chat session.
//
// Only the LAST 5 NON-EMPTY lines are examined. A report that merely *quotes* a
// marker while explaining it mid-text must not end the cron — and an agent asked
// "how do I stop a cron?" writes exactly that. The skill mandates the marker as the
// FINAL line of the reply, so five lines is all the slack a real one ever needs
// (both markers together, plus a short sign-off) while nothing further up can fire.
//
// Pure: no I/O, no clock. The caller decides what to do with the verdict.
const DONE_MARKER = 'CRON_DONE';
const NEXT_MARKER_RE = /^CRON_NEXT\s+(\d{1,5})$/;
const MARKER_WINDOW = 5;                  // trailing non-empty lines examined
const NEXT_MIN_SEC = 60;                  // 1 minute
const NEXT_MAX_SEC = 7 * 24 * 60 * 60;    // 7 days — the 1..10080 minutes the skill states

export function parseRunMarkers(output: string): {
  output: string;
  done: boolean;
  nextIntervalSec: number | null;
} {
  const lines = output.split('\n');
  // Indices of the trailing window, oldest-first, so "the last CRON_NEXT wins" is
  // just "keep overwriting as we go".
  const window: number[] = [];
  for (let i = lines.length - 1; i >= 0 && window.length < MARKER_WINDOW; i--) {
    if (lines[i].trim() !== '') window.push(i);
  }
  window.reverse();

  let done = false;
  let nextIntervalSec: number | null = null;
  const strip = new Set<number>();
  for (const i of window) {
    const line = lines[i].trim();
    if (line === DONE_MARKER) {
      done = true;
      strip.add(i);
      continue;
    }
    const m = NEXT_MARKER_RE.exec(line);
    if (!m) continue;
    // A syntactic marker line is ALWAYS stripped, even when its number is refused:
    // the protocol line is never something a reader wants in the report.
    strip.add(i);
    const sec = Number(m[1]) * 60;
    // Out of range is REFUSED, not clamped to the nearest bound. `CRON_NEXT 0` is a
    // typo or a misunderstanding, and silently reading it as "every minute" would
    // turn one bad line into a runaway; falling back to the cron's stored interval
    // is the safe reading of a nonsense value.
    nextIntervalSec = sec >= NEXT_MIN_SEC && sec <= NEXT_MAX_SEC ? sec : null;
  }

  // Untouched output stays byte-identical — only a strip earns the trailing trim.
  const cleaned =
    strip.size === 0
      ? output
      : lines.filter((_, i) => !strip.has(i)).join('\n').replace(/\s+$/, '');
  return { output: cleaned, done, nextIntervalSec };
}

// What a cron fire actually sends: the stored prompt plus the standing note that
// this turn is the whole conversation.
//
// (a) keeps a run from ending with no capturable text, and (b) tells the agent
// NOT to background long commands: the session is torn down the instant it
// replies, so a backgrounded command's completion notification never arrives and
// its result is lost. The model-arena matchmake cron hit exactly this — it kept
// replying "I'll report when the background run finishes", then got killed.
//
// Shared by all three fire paths. It used to be inlined in the pane path's
// sendKeys, so a codex cron never received it at all — the same hazard, minus
// the warning, on a backend nobody had thought about.
// NOTE: ~/.claude/hooks/memory-check.mjs recognises a cron transcript by the
// literal sentence "Scheduled cron run. This session is torn down right after
// you reply" below — it is that hook's fallback for gateways too old to set
// HERMIT_CRON=1. Reword it and the hook goes back to eating cron reports,
// silently. Drop the fallback (and this note) once every gateway is new enough.
export function cronPrompt(prompt: string): string {
  return (
    `${prompt}\n\n(Scheduled cron run. This session is torn down right after you reply, so do NOT ` +
    `end your turn while a command is still running in the background — its result could never be ` +
    `reported. Prefer running commands in the foreground; if the harness auto-backgrounds a long one, ` +
    `BLOCK within this same turn until it finishes (poll its output / use the Monitor tool), then read ` +
    `the output and reply with a short result summary. Reply only once the work is ACTUALLY done.)`
  );
}

// ── What the gateway OBSERVED about a fire ──────────────────────────────────
//
// Status is a statement about the TURN, not a guess at whether the scheduled
// work succeeded — only the work knows that, and saying so is its own RESULT
// signal's job (the `cron` skill's CRON_DONE / a report the reader can judge).
//
//   ok         settled cleanly AND produced final text
//   no_output  settled cleanly but said nothing (harness exited silently, or an
//              undetected transcript drift)
//   timeout    never settled — hit the cap, or the host was suspended past it.
//              Un-observable is NOT failed: the work may well have finished.
//   error      the harness threw. Message is copied through VERBATIM.
//
// Pure, exported and tested on purpose. This logic used to be inlined in
// fireInner, where it was the one part of cron-runner with no test at all —
// which is how eleven silent failures across six agents went unnoticed from
// 2026-08-10 (memory/notes/bug_cron_false_ok_synthetic.md). Now that a fire can
// land on any of six backends, two paths have to classify identically or the
// same failure reads differently depending on which backend ran it; a shared
// pure function is the only version of that which stays true.
export type CronStatus = 'ok' | 'no_output' | 'timeout' | 'error';

export function classifyRun(o: {
  /** Did the turn go genuinely idle, rather than fall through the deadline? */
  settled: boolean;
  /** Final assistant text captured, if any. */
  text: string;
  /** The per-run cap, for the message only. */
  timeoutMs: number;
  /**
   * What the BACKEND said went wrong, in its own words.
   *
   * Not an exception — that is the whole point. Every runtime except codex
   * reports an expired login, a spent quota, a dead child or a failed boot as an
   * ordinary `system` message and then simply produces no assistant text
   * (runtime/pi-events.ts, claude-sdk-events.ts). Read only for text, all of
   * those look identical to a cron that quietly did nothing — which is exactly
   * how "Login expired · Please run /login" was recorded as `ok` for eleven runs
   * across six agents. A note with nothing else to show IS the result, and it is
   * copied through verbatim: the 2026-08-15 codex outage stayed invisible for
   * six hours because a real refusal had been flattened into a generic status.
   */
  harnessNote?: string;
  /**
   * Did that note actually report a FAILURE, rather than narrate?
   *
   * The two are different questions and conflating them broke it in both
   * directions. Not every system message is bad news — claude-sdk narrates a
   * backgrounded command and an auto-compaction the same way it reports a dead
   * turn — so treating any note as failure turns an ordinary tool-only run red
   * and fires a failure push. And a failure that DID produce text is still a
   * failure: "Login expired · Please run /login" arrives as perfectly ordinary
   * assistant text, which is exactly how it was recorded as `ok` eleven times.
   * So the note decides what is SHOWN, and this decides the STATUS.
   */
  harnessFailed?: boolean;
}): { status: CronStatus; output: string } {
  const text = o.text.trim();
  const note = (o.harnessNote ?? '').trim();
  // A note ALONGSIDE a real answer is kept, not dropped: a turn that reported
  // and then hit a rate limit is still an answer the reader wants, with a
  // warning attached.
  //
  // It goes FIRST, and that is load-bearing, not taste. parseRunMarkers reads
  // the last 5 non-empty lines of this output for CRON_DONE / CRON_NEXT, and the
  // skill mandates the marker as the final line of the reply — so a note appended
  // AFTER the report pushes the marker out of that window and a cron that asked
  // to stop goes on firing forever. Same failure the "read the markers before
  // capping" rule below exists to prevent, approached from the other end: the
  // agent's own text must stay at the tail. (A warning reads better as a banner
  // anyway.)
  const withNote = (s: string) => (note ? (s ? `${note}\n\n${s}` : note) : s);
  // A reported failure IS the observation. It beats "un-observable" (timeout)
  // and it beats whatever the turn managed to say first — believe the backend
  // when it says its own turn did not complete.
  if (o.harnessFailed) {
    return {
      status: 'error',
      output: withNote(text) || '[cron-runner] the backend reported a failed turn without saying why.',
    };
  }
  if (!o.settled) {
    // Text WITH a timeout still reports the text: a run that said something
    // useful and then ran long is far more legible than the boilerplate.
    return {
      status: 'timeout',
      output: withNote(
        text ||
          `[cron-runner] no final text captured before the ${Math.round(o.timeoutMs / 60_000)}min cap — ` +
            `a frozen/suspended host looks exactly like this. The scheduled work itself may have completed; ` +
            `check the agent's own result log.`,
      ),
    };
  }
  if (!text) {
    // Note included: a backend that narrated (a backgrounded command, an
    // auto-compaction) and then said nothing is a far more diagnosable
    // no_output than the boilerplate alone.
    return {
      status: 'no_output',
      output: withNote(
        '[cron-runner] turn went idle but produced no final text (the backend may have exited silently, ' +
        'or an undetected transcript-uuid drift).',
      ),
    };
  }
  return { status: 'ok', output: withNote(text) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// extractText now lives in ./claude-code (shared); cron trims at the call site.

// paneIsWorking (the "esc to interrupt" pane work-marker) lives in ./pane and is
// shared with the chat dispatch gate + session-snapshot collector. Here it keeps
// the cron pane alive through gaps that write NO transcript line — the agent
// composing its final report, or waiting on a harness-auto-backgrounded command.

// When is this cron next eligible to fire? nextFire is authoritative once set;
// fall back to lastFire + interval, and treat a never-fired cron as due now.
function dueAtMs(c: Cron): number {
  if (c.nextFire) return new Date(c.nextFire).getTime();
  if (c.lastFire) return new Date(c.lastFire).getTime() + c.intervalSec * 1000;
  return 0;
}

// nextFire = base + interval ± uniform(jitter). Gateway is plain Node here, so
// Math.random is fine (unlike the Workflow sandbox).
function computeNextFire(c: Cron, fromMs: number): number {
  const jitterMs =
    c.jitterSec > 0 ? Math.round((Math.random() * 2 - 1) * c.jitterSec * 1000) : 0;
  return fromMs + c.intervalSec * 1000 + jitterMs;
}

export async function tick(): Promise<void> {
  let crons: Cron[];
  try {
    crons = (await api.listCrons()) as Cron[];
  } catch (e) {
    console.error('[cron] listCrons failed:', e);
    return;
  }
  const now = Date.now();
  for (const c of crons) {
    if (!c.enabled) continue;
    if (isLocked('cron', c.id)) continue;
    if (dueAtMs(c) > now) continue;
    fire(c).catch((e) => console.error('[cron] fire error', c.id.slice(0, 8), e));
  }
}

async function fire(c: Cron): Promise<void> {
  // Take the per-cron lock and GUARANTEE its release, however fireInner exits. The
  // release used to sit at the very end of the body, so a throw before it (e.g. a
  // bad schedule expr) stranded the cron as permanently "running" until a gateway
  // restart. cronTick already skips a locked cron, so this tryAcquire normally wins.
  if (!tryAcquire('cron', c.id)) return;
  try {
    await fireInner(c);
  } finally {
    release('cron', c.id);
  }
}

async function fireInner(c: Cron): Promise<void> {
  const startedAt = Date.now();
  // Throwaway pane id — paneName() keeps the last 12 chars (the ms timestamp),
  // so concurrent crons never collide.
  const runSessionId = `cron-${c.id}-${startedAt}`;
  const cwd = c.directory || c.agentDirectory || path.join(AGENTS_ROOT, c.agentName);

  // Tell the dashboard we started: creates a CronRun(running), flips the Cron's
  // lastStatus + lastFire, and stamps nextFire so we don't re-fire mid-run.
  const nextFire = new Date(computeNextFire(c, startedAt)).toISOString();
  let runId: string | null = null;
  try {
    const r = await api.cronRun({
      phase: 'start',
      cronId: c.id,
      firedAt: new Date(startedAt).toISOString(),
      nextFire,
    });
    runId = r?.runId ?? null;
  } catch (e) {
    console.error('[cron] runStart post failed', e);
  }

  // ── Which backend runs this fire ───────────────────────────────────────────
  //
  // The HARNESS, resolved by the dashboard (cron.listForGateway → resolveRuntime,
  // the same resolver chat uses). Absent means an older dashboard that sends no
  // runtime at all → the pane, i.e. exactly what every cron did before this
  // existed.
  //
  // Three ways to fire, picked here and nowhere else:
  //   codex-exec   its own one-shot `codex exec` (below) — kept bespoke because
  //                it surfaces a refusal verbatim, which is what made the
  //                2026-08-15 quota outage visible at all.
  //   any other    driven through its AgentRuntime by ./runtime/cron-turn. This
  //   AgentRuntime is what pi, omp, prime, dsh and claude-sdk crons now take;
  //                until 2026-08-26 the `else` below swallowed every one of them
  //                and ran it on the pane, i.e. on Claude, whatever the picker
  //                said.
  //   claude-tmux  the pane path, with the transcript pinning and drift
  //                self-heal that only it needs.
  const harness = c.runtime ?? 'claude-tmux';
  const mode = c.runtimeMode ?? null;
  // The name the USER picked, for the log line. A fire that logs "[pi-rpc]" when
  // the card says "pi + Kimi" is the gap that costs an afternoon of grepping.
  const backendLabel = c.backendId && c.backendId !== harness ? `${c.backendId}/${harness}` : harness;
  const viaRuntime = harness !== 'codex-exec' && canRunCronTurn(harness, mode);
  const viaPane = harness !== 'codex-exec' && !viaRuntime;
  if (harness !== 'claude-tmux' && viaPane) {
    // A harness this gateway has no runtime for. Falling back to the pane keeps
    // the cron firing, but on the WRONG backend — say so once per fire rather
    // than letting it look intentional, which is precisely how the pi/dsh crons
    // ran on Claude unnoticed.
    console.warn(
      `[cron] ${c.id.slice(0, 8)}: no runtime for harness "${harness}" — falling back to the ` +
        `claude pane. This fire does NOT run on the backend the dashboard resolved.`,
    );
  }
  console.log('[cron] fire', c.id.slice(0, 8), c.agentName, 'in', cwd, `[${backendLabel}]`);

  let output = '';
  // Status = what the gateway OBSERVED about the turn, not a guess at whether the
  // scheduled work succeeded (only the work knows that — that's its own RESULT
  // signal's job). ok = clean idle settle WITH final text; no_output = settled but
  // no text (claude exited silently / undetected drift); timeout = hit
  // RUN_TIMEOUT_MS or the host was suspended past the deadline (un-observable ≠
  // failed); error = exception thrown. We no longer emit a bare 'fail' — every old
  // 'fail' was really one of {timeout, no_output, error}.
  let status: 'ok' | 'no_output' | 'timeout' | 'error' = 'error';
  let stop: () => void = () => {};
  // Pinned transcript uuid. Hoisted out of the try so `finally` can unpin it
  // however we exit.
  //
  // Held ONLY on the pane path: the release lives in that branch's `finally`, so
  // holding it unconditionally would leak one uuid per codex or runtime fire —
  // forever, since nothing else ever unpins it. (The runtime path holds its own
  // id instead, reported by onStarted once the backend has picked one.)
  const claudeUuid = randomUUID();
  if (viaPane) holdCronUuid(claudeUuid);
  // A drift-adopted transcript is just as much this fire's as the pinned one —
  // hoisted so `finally` releases whichever we ended up holding.
  let adoptedUuid: string | null = null;
  // The transcript we ended up tailing (the pinned one, or a drift-adopted one).
  // Hoisted for the same reason: a truncation notice has to name the file that still
  // holds the full text, and that is decided inside the try.
  let jsonlPath = '';

  // ── codex path ───────────────────────────────────────────────────────────
  //
  // A one-shot `codex exec`: no tmux pane, no pinned session uuid, no transcript
  // to tail — codex hands the turn back directly, so none of the claude-side
  // machinery below (or its drift self-heal) applies. Written as
  // `if (codex) { … } else try { … }` so the claude branch keeps its original
  // indentation and this stays a readable diff rather than a 130-line reflow.
  //
  // The error is reported VERBATIM. Flattening a codex rejection into a generic
  // status is what made the 2026-08-15 outage invisible: the account had hit its
  // usage limit and every fire reported "timeout", so the logs blamed the task
  // for six hours while the real message sat in the rollout.
  if (harness === 'codex-exec') {
    try {
      output = await runCodexCronTurn({
        agentName: c.agentName,
        cwd,
        prompt: cronPrompt(c.prompt),
        signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      });
      // The stream ending IS the settle: codex hands the turn back rather than
      // going quiet, so there is no idle window to wait out.
      ({ status, output } = classifyRun({ settled: true, text: output, timeoutMs: RUN_TIMEOUT_MS }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A blown deadline is 'timeout' (un-observable ≠ failed), same vocabulary
      // as the claude path; anything else is a real error worth reading.
      const timedOut = /abort|timeout/i.test(msg);
      status = timedOut ? 'timeout' : 'error';
      output = `[cron-runner] codex: ${msg}`;
    }
  } else if (viaRuntime) {
    // ── runtime path ─────────────────────────────────────────────────────────
    //
    // pi / omp / prime / dsh / claude-sdk. One turn through the backend's own
    // AgentRuntime, torn down on the way out. Same verbatim-error rule as codex,
    // for the same reason: an auth failure or a spent quota must arrive as ITS
    // OWN message, not flattened into a generic status that sends the reader to
    // the agent's logs for an answer that was never there.
    let sdkUuid: string | null = null;
    try {
      const turn = await runRuntimeCronTurn({
        harness,
        mode,
        agentName: c.agentName,
        cwd,
        prompt: cronPrompt(c.prompt),
        sessionId: runSessionId,
        credentialId: c.runtimeCredentialId ?? null,
        provider: c.runtimeProvider ?? null,
        model: c.runtimeModel ?? null,
        isOrchestrator: !!c.isOrchestrator,
        timeoutMs: RUN_TIMEOUT_MS,
        idleMs: IDLE_DONE_MS,
        // claude-sdk shares the agent's project dir with its chats — register the
        // transcript as cron-owned for as long as this fire holds it.
        onStarted: (uuid) => {
          sdkUuid = uuid;
          holdCronUuid(uuid);
        },
      });
      ({ status, output } = classifyRun({
        settled: turn.settled,
        text: turn.text,
        timeoutMs: RUN_TIMEOUT_MS,
        // What the backend said about its own failure, if it said anything. None
        // of these runtimes throws on an expired login or a spent quota — see
        // CronTurnOutcome.harnessNote.
        harnessNote: turn.harnessNote,
        harnessFailed: turn.harnessFailed,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const timedOut = /abort|timeout/i.test(msg);
      status = timedOut ? 'timeout' : 'error';
      output = `[cron-runner] ${harness}: ${msg}`;
    } finally {
      if (sdkUuid) releaseCronUuid(sdkUuid);
    }
  } else try {
    // The orchestrator (Brain) runs its crons (e.g. the daily dream) WITH the
    // brain MCP so they can roster()/agent_activity()/dispatch(). Other agents'
    // crons stay headless (no MCP). The stub keys on this run's id.
    // `--effort max`: cron turns also run at the highest reasoning effort (settings.json
    // `effortLevel` maxes at 'high', so max comes from the flag). Brain's crons additionally
    // get the brain MCP; other agents' crons stay headless.
    // `--dangerously-skip-permissions`: cron is UNATTENDED — a permission prompt
    // (native, or the web-permission hook) can never be answered, so without this
    // the turn hangs until RUN_TIMEOUT_MS (2h). Chat sessions already run bypass
    // (chat-runner); a cron runs the agent's OWN stored prompt — same trust level.
    // (A Claude Code update ~2026-06-26 began prompting for previously-allowed Bash,
    // silently hanging every daily cron at the 2h cap until this was added.)
    const claudeArgs = c.isOrchestrator
      ? ['--dangerously-skip-permissions', '--effort', 'max', '--mcp-config', buildMcpConfigArg(runSessionId, true)]
      : ['--dangerously-skip-permissions', '--effort', 'max'];
    ensureSession({
      sessionId: runSessionId,
      cwd,
      claudeArgs,
      claudeSessionUuid: claudeUuid,
      // Same as chat-runner: Claude Code's built-in auto-memory is retired
      // fleet-wide (authoritative switch is ~/.claude/settings.json); agents
      // read and write their own <agent>/memory/.
      // Only Brain receives the hermit MCP above. A headless ordinary cron has
      // no consumer for the dashboard machine key, so do not widen that secret
      // into its Claude process or tool subprocesses.
      env: cronPaneEnv(!!c.isOrchestrator, runSessionId),
    });
    jsonlPath = path.join(encodedProjectDir(cwd), `${claudeUuid}.jsonl`);
    // We pinned --session-id <claudeUuid>, so claude should write exactly this
    // transcript. If it didn't honor the flag (respawn / version quirk) the pinned
    // file never appears and we'd tail an empty path forever → a real run
    // misreported as no_output. Parity with chat-runner's drift self-heal: when the
    // pinned transcript doesn't show up, adopt the newest transcript written during
    // THIS fire that nobody else owns. watchTranscript tails `-n +1` so the adopted
    // file replays from line 1 — no early text is lost.
    const appeared = await awaitTranscript(jsonlPath, TRANSCRIPT_WAIT_MS).then(() => true).catch(() => false);
    if (!appeared) {
      // Adopt the newest transcript created around/after this run started (mtime lower
      // bound) that no sibling cron and no chat session owns — see adoptDriftTranscript.
      const live = adoptDriftTranscript(cwd, {
        pinned: cronOwnedUuids(),
        chatOwned: chatOwnedUuids(),
        minMtimeMs: startedAt - 2_000,
      });
      if (live) {
        console.warn(
          `[cron] ${c.id.slice(0, 8)}: session uuid drift — pinned ${claudeUuid.slice(0, 8)} ` +
            `has no transcript; adopting live ${live.uuid.slice(0, 8)}`,
        );
        jsonlPath = path.join(encodedProjectDir(cwd), `${live.uuid}.jsonl`);
        adoptedUuid = live.uuid;
        holdCronUuid(adoptedUuid);
      }
    }

    let lastText = '';
    let lastEventAt = Date.now();
    // Track in-flight tool calls: a long FOREGROUND tool (e.g. a multi-minute
    // Bash) leaves the transcript silent while it runs, which must NOT be read as
    // "turn complete". A tool is in flight while requested (tool_use) outnumber
    // returned (tool_result).
    let toolsOut = 0;
    let toolsBack = 0;
    stop = watchTranscript(jsonlPath, (ev) => {
      lastEventAt = Date.now();
      if (ev.type === CcEvent.assistant && ev.message?.content) {
        const t = extractText(ev.message.content).trim();
        if (t) lastText = t; // keep the latest assistant text block as the result
        if (Array.isArray(ev.message.content)) {
          for (const b of ev.message.content) if (b?.type === CcBlock.toolUse) toolsOut++;
        }
      } else if (ev.type === CcEvent.user && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) if (b?.type === CcBlock.toolResult) toolsBack++;
      }
    });

    // Fire the prompt, with the same standing note every other path sends — see
    // cronPrompt.
    sendKeys(runSessionId, cronPrompt(c.prompt));
    lastEventAt = Date.now();

    // Settle: wait until the assistant has been quiet for IDLE_DONE_MS after
    // producing some text, or the hard timeout trips.
    const deadline = startedAt + RUN_TIMEOUT_MS;
    let sawAssistant = false;
    let settled = false; // true ⇒ the turn went genuinely idle (clean completion).
                         // Still false at loop exit ⇒ we fell through the deadline:
                         // the real 2h cap OR the host was suspended and wall-clock
                         // jumped past it. Either way un-observable, NOT a failure.
    while (Date.now() < deadline) {
      await sleep(1_000);
      if (lastText) sawAssistant = true;
      // Keep the run alive while the agent is still busy: a tool in flight, OR the
      // pane TUI still shows claude's "esc to interrupt" working marker. The pane
      // check survives gaps that write no transcript line — the agent composing
      // its final report, or waiting on a harness-auto-backgrounded command —
      // which the transcript-idle heuristic alone mistook for "done" and cut the
      // report off. Finish only after the pane has truly been idle for IDLE_DONE_MS.
      if (toolsOut > toolsBack || (await paneIsWorking(runSessionId))) lastEventAt = Date.now();
      if (sawAssistant && Date.now() - lastEventAt > IDLE_DONE_MS) { settled = true; break; }
    }
    // Classify by WHY the loop ended, not by text presence alone. The old
    // `lastText ? ok : fail` reported every timeout / suspended / silent run as a
    // hard failure — the fleet-wide false-FAIL on the status light. (false-OK, the
    // reverse, is NOT the gateway's to judge — that's the work's own RESULT signal.)
    ({ status, output } = classifyRun({ settled, text: lastText, timeoutMs: RUN_TIMEOUT_MS }));
  } catch (e) {
    output = `[cron-runner] ${String(e)}`;
    status = 'error';
  } finally {
    releaseCronUuid(claudeUuid);
    if (adoptedUuid) releaseCronUuid(adoptedUuid);
    try { stop(); } catch {}
    await killSession(runSessionId).catch(() => {});
  }

  // Read the markers BEFORE capping, and never the other way round: capOutput keeps
  // the HEAD of a 32K-capped output, so a CRON_DONE on the last line of a long report
  // would be cut off before anything could see it and the cron would go on firing
  // forever. Ordering IS the mechanism here.
  const { output: reported, done, nextIntervalSec } = parseRunMarkers(output);
  const capped = capOutput(reported, OUTPUT_MAX, jsonlPath || undefined);
  const durationMs = Date.now() - startedAt;
  if (capped.length !== reported.length) {
    console.warn(`[cron] ${c.id.slice(0, 8)}: output truncated ${reported.length} → ${OUTPUT_MAX} chars`);
  }
  if (done) console.log(`[cron] ${c.id.slice(0, 8)}: run signalled CRON_DONE`);
  if (nextIntervalSec !== null)
    console.log(`[cron] ${c.id.slice(0, 8)}: run signalled CRON_NEXT ${nextIntervalSec / 60}m`);
  try {
    await api.cronRun({
      phase: 'finish',
      cronId: c.id,
      runId,
      status,
      output: capped,
      durationMs,
      // Both optional on the dashboard side — send a field only when it fired, so an
      // ordinary run's payload is exactly what it was before this existed.
      ...(done ? { done: true } : {}),
      ...(nextIntervalSec !== null ? { nextIntervalSec } : {}),
    });
  } catch (e) {
    console.error('[cron] runFinish post failed', e);
  }

  console.log('[cron] done', c.id.slice(0, 8), status, durationMs, 'ms');
}
