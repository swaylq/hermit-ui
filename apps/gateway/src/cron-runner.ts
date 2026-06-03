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
  encodedProjectDir,
  kill as killSession,
} from '@hermit-ui/tmux-driver';
import { AGENTS_ROOT } from './config';
import { api } from './api';
import { paneIsWorking } from './pane';

const RUN_TIMEOUT_MS = 120 * 60_000; // hard cap per run (2h)
const IDLE_DONE_MS = 8_000;         // assistant quiet this long ⇒ turn complete
const OUTPUT_TAIL = 4096;

type Cron = {
  id: string;
  agentName: string;
  agentDirectory: string | null;
  directory: string | null;
  prompt: string;
  intervalSec: number;
  jitterSec: number;
  enabled: boolean;
  lastFire: string | null;
  nextFire: string | null;
};

const running = new Set<string>();

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
  let status: 'ok' | 'fail' = 'fail';
  let stop: () => void = () => {};

  try {
    const claudeUuid = randomUUID();
    ensureSession({
      sessionId: runSessionId,
      cwd,
      claudeArgs: [],
      claudeSessionUuid: claudeUuid,
    });
    const jsonlPath = path.join(encodedProjectDir(cwd), `${claudeUuid}.jsonl`);
    await awaitTranscript(jsonlPath).catch(() => {});

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
      if (sawAssistant && Date.now() - lastEventAt > IDLE_DONE_MS) break;
    }
    output = lastText;
    status = lastText ? 'ok' : 'fail';
  } catch (e) {
    output = `[cron-runner] ${String(e)}`;
    status = 'fail';
  } finally {
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
