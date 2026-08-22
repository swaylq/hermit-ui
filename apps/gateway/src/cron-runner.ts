// cron-runner.ts — fire Cron jobs as fresh tmux + claude turns in the agent dir.
//
// Replaces the happy-based system-task-runner. Each fire (2b: isolated, no
// session reuse) spawns an interactive `claude` in a throwaway tmux pane in the
// agent's directory, sends the cron prompt, tails the JSONL transcript for the
// assistant turn, records a CronRun, then kills the pane. NO happy, NO
// `claude -p` — same interactive-claude-via-tmux path the chat-runner uses.
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
   * (cron.listForGateway): the report session's runtime, else the machine's
   * enabled backend. Absent on an older dashboard → the claude path, which is
   * what every cron did before this field existed.
   */
  runtime?: string | null;
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

  // Which backend runs this fire. Resolved by the dashboard; absent (older
  // dashboard) means the claude path, i.e. exactly what every cron did before.
  const runtimeKind = c.runtime ?? 'claude-tmux';
  console.log('[cron] fire', c.id.slice(0, 8), c.agentName, 'in', cwd, `[${runtimeKind}]`);

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
  // Held ONLY on the claude path: the release lives in that branch's `finally`,
  // so holding it unconditionally would leak one uuid per codex fire — forever,
  // since nothing else ever unpins it.
  const claudeUuid = randomUUID();
  if (runtimeKind !== 'codex-exec') holdCronUuid(claudeUuid);
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
  if (runtimeKind === 'codex-exec') {
    try {
      output = await runCodexCronTurn({
        agentName: c.agentName,
        cwd,
        prompt: c.prompt,
        signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      });
      status = output ? 'ok' : 'no_output';
      if (!output) output = '[cron-runner] codex turn finished without a final message.';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A blown deadline is 'timeout' (un-observable ≠ failed), same vocabulary
      // as the claude path; anything else is a real error worth reading.
      const timedOut = /abort|timeout/i.test(msg);
      status = timedOut ? 'timeout' : 'error';
      output = `[cron-runner] codex: ${msg}`;
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

    // Fire the prompt. The trailing nudge (a) keeps the run from ending with no
    // capturable text, and (b) tells the agent NOT to background long commands:
    // this throwaway session is torn down the instant it replies, so a
    // backgrounded command's completion notification never arrives and its result
    // is lost (the model-arena matchmake cron hit exactly this — it kept replying
    // "I'll report when the background run finishes", then got killed).
    sendKeys(
      runSessionId,
      `${c.prompt}\n\n(Scheduled cron run. This session is torn down right after you reply, so do NOT end your turn while a command is still running in the background — its result could never be reported. Prefer running commands in the foreground; if the harness auto-backgrounds a long one, BLOCK within this same turn until it finishes (poll its output / use the Monitor tool), then read the output and reply with a short result summary. Reply only once the work is ACTUALLY done.)`,
    );
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
    output = lastText;
    // Classify by WHY the loop ended, not by text presence alone. The old
    // `lastText ? ok : fail` reported every timeout / suspended / silent run as a
    // hard failure — the fleet-wide false-FAIL on the status light. (false-OK, the
    // reverse, is NOT the gateway's to judge — that's the work's own RESULT signal.)
    if (settled) {
      status = lastText ? 'ok' : 'no_output';
      if (!lastText)
        output =
          '[cron-runner] turn went idle but produced no final text (claude may have exited silently, or an undetected transcript-uuid drift).';
    } else {
      status = 'timeout';
      if (!lastText)
        output =
          `[cron-runner] no final text captured before the ${Math.round(RUN_TIMEOUT_MS / 60_000)}min cap — ` +
          `a frozen/suspended host looks exactly like this. The scheduled work itself may have completed; ` +
          `check the agent's own result log.`;
    }
  } catch (e) {
    output = `[cron-runner] ${String(e)}`;
    status = 'error';
  } finally {
    releaseCronUuid(claudeUuid);
    if (adoptedUuid) releaseCronUuid(adoptedUuid);
    try { stop(); } catch {}
    await killSession(runSessionId).catch(() => {});
  }

  const capped = capOutput(output, OUTPUT_MAX, jsonlPath || undefined);
  const durationMs = Date.now() - startedAt;
  if (capped.length !== output.length) {
    console.warn(`[cron] ${c.id.slice(0, 8)}: output truncated ${output.length} → ${OUTPUT_MAX} chars`);
  }
  try {
    await api.cronRun({
      phase: 'finish',
      cronId: c.id,
      runId,
      status,
      output: capped,
      durationMs,
    });
  } catch (e) {
    console.error('[cron] runFinish post failed', e);
  }

  console.log('[cron] done', c.id.slice(0, 8), status, durationMs, 'ms');
}
