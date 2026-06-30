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
  listTranscripts,
  encodedProjectDir,
  kill as killSession,
} from '@hermit-ui/tmux-driver';
import { AGENTS_ROOT } from './config';
import { api } from './api';
import { paneIsWorking } from './pane';
import { buildMcpConfigArg } from './chat-runner';

const RUN_TIMEOUT_MS = 120 * 60_000; // hard cap per run (2h)
const IDLE_DONE_MS = 8_000;         // assistant quiet this long ⇒ turn complete
const OUTPUT_TAIL = 4096;

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
};

const running = new Set<string>();
// claude-session uuids pinned by an in-flight fire — so the uuid-drift self-heal
// never adopts a SIBLING cron's live transcript (agents share one project dir).
const pinnedUuids = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

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
    if (running.has(c.id)) continue;
    if (dueAtMs(c) > now) continue;
    fire(c).catch((e) => console.error('[cron] fire error', c.id.slice(0, 8), e));
  }
}

async function fire(c: Cron): Promise<void> {
  running.add(c.id);
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

  console.log('[cron] fire', c.id.slice(0, 8), c.agentName, 'in', cwd);

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
  const claudeUuid = randomUUID();
  pinnedUuids.add(claudeUuid);

  try {
    // The orchestrator (Brain) runs its crons (e.g. the daily dream) WITH the
    // brain MCP so they can roster()/agent_activity()/dispatch(). Other agents'
    // crons stay headless (no MCP). The stub keys on this run's id.
    // `--effort max`: cron turns also run at the highest reasoning effort (settings.json
    // `effortLevel` maxes at 'high', so max comes from the flag). Brain's crons additionally
    // get the brain MCP; other agents' crons stay headless.
    const claudeArgs = c.isOrchestrator
      ? ['--effort', 'max', '--mcp-config', buildMcpConfigArg(runSessionId, true)]
      : ['--effort', 'max'];
    ensureSession({
      sessionId: runSessionId,
      cwd,
      claudeArgs,
      claudeSessionUuid: claudeUuid,
    });
    let jsonlPath = path.join(encodedProjectDir(cwd), `${claudeUuid}.jsonl`);
    // We pinned --session-id <claudeUuid>, so claude should write exactly this
    // transcript. If it didn't honor the flag (respawn / version quirk) the pinned
    // file never appears and we'd tail an empty path forever → a real run
    // misreported as no_output. Parity with chat-runner's drift self-heal: when the
    // pinned transcript doesn't show up, adopt the newest transcript written during
    // THIS fire that isn't pinned by another in-flight cron. watchTranscript tails
    // `-n +1` so the adopted file replays from line 1 — no early text is lost.
    const appeared = await awaitTranscript(jsonlPath).then(() => true).catch(() => false);
    if (!appeared) {
      const live = listTranscripts(cwd)
        .filter((t) => t.size > 0 && !pinnedUuids.has(t.uuid) && t.mtimeMs >= startedAt - 2_000)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
      if (live) {
        console.warn(
          `[cron] ${c.id.slice(0, 8)}: session uuid drift — pinned ${claudeUuid.slice(0, 8)} ` +
            `has no transcript; adopting live ${live.uuid.slice(0, 8)}`,
        );
        jsonlPath = path.join(encodedProjectDir(cwd), `${live.uuid}.jsonl`);
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
      if (ev.type === 'assistant' && ev.message?.content) {
        const t = extractText(ev.message.content);
        if (t) lastText = t; // keep the latest assistant text block as the result
        if (Array.isArray(ev.message.content)) {
          for (const b of ev.message.content) if (b?.type === 'tool_use') toolsOut++;
        }
      } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) if (b?.type === 'tool_result') toolsBack++;
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
    pinnedUuids.delete(claudeUuid);
    try { stop(); } catch {}
    await killSession(runSessionId).catch(() => {});
  }

  const tail = output.length > OUTPUT_TAIL ? output.slice(-OUTPUT_TAIL) : output;
  const durationMs = Date.now() - startedAt;
  try {
    await api.cronRun({
      phase: 'finish',
      cronId: c.id,
      runId,
      status,
      output: tail,
      durationMs,
    });
  } catch (e) {
    console.error('[cron] runFinish post failed', e);
  }

  running.delete(c.id);
  console.log('[cron] done', c.id.slice(0, 8), status, durationMs, 'ms');
}
