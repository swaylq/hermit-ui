// hermit-ui gateway — long-running Mac-local process that pushes filesystem-
// derived state up to the dashboard's postgres and fires Cron jobs against
// the local agent tree.
//
// Intervals (staggered):
//   agents              5 min  (static folder metadata — markdowns barely churn)
//   session-snapshots   8 s    (per-ChatSession runtime: working/idle from the
//                               pane's TUI via capture-pane, alive/pid/ctx/jsonl
//                               tail. Drives sidebar badges + context% + loop-card
//                               freshness. Was 15s "to avoid hammering"; halved to
//                               8s once the shared bcrypt auth cache made /api/sync
//                               cheap — collector is async (execFile) so it never
//                               blocks the loop. The chat page still flips to
//                               "working" instantly off its own SSE stream.)
//   cron tick           15 s   (fires due Cron jobs on their resolved backend)
//   chat tick           2  s
//   chat-cancel tick    1.5s
//   chat-restart tick   2  s
//   takeover watch      8  s  (reactive Brain poke while it drives a conversation
//                              the human handed over, + the cap sweep)
//   usage               30 min  (was 5 min — dashboard now relies on these
//                                pushes exclusively, no on-demand ccusage)

import { collectAgentsFromList } from './collect/agents';
import { collectSessionSnapshots } from './collect/session-snapshot';
import { startSessionStatePush } from './collect/session-state-push';
import { collectHostStat } from './collect/host-stat';
import { collectUsage, usageWindowStart } from './collect/usage';
import { collectUsageWindows } from './collect/window';
import { collectPlanUsage } from './collect/plan-usage';
import { collectCodexUsage } from './collect/codex-usage';
import { collectKimiUsage } from './collect/kimi-usage';
import { api } from './api';
import { tick as cronTick } from './cron-runner';
import { chatTick, chatCancelTick, chatRestartTick, chatHibernateTick, shutdownChatRunner, flushAllSyncBuffers } from './chat-runner';
import { shutdownClaudeSdk } from './runtime/claude-sdk';
import { allRuntimes } from './runtime';
import { drainSessions, shutdownBudgetMs } from './shutdown-drain';
import { sdkBucketTick } from './collect/sdk-bucket';
import { agentRequestTick } from './agent-lifecycle';
import { machineRequestTick } from './machine-requests';
import { startLoginBridge } from './login-bridge';
import { fileTransferTick } from './file-station';
import { pushGlobalSkills, globalSkillRequestTick } from './global-skills';
import { knowledgeRequestTick, reconcileKnowledgeOnStartup } from './knowledge';
import { globalMemoryTick } from './global-memory';
import { seedPiConfigFromEnv } from './pi-config';
import { chromeReaperTick } from './chrome-reaper';
import { cpuReaperTick } from './cpu-reaper';
import { strayReaperTick } from './stray-reaper';
import { orphanPaneReaperTick } from './orphan-pane-reaper';
import { orphanChildReaperTick } from './orphan-child-reaper';
import { startTrackingInFlightTurns, recoverInterruptedTurns, freezeInFlightTurns, recordInterruptedTurns, reattachHostSessions } from './interrupted-turns';
import { checkPm2Config } from './pm2-config-check';
import { sessionPurgeTick } from './session-purge';
import { startControlChannel, shutdownControlChannel } from './control-channel';
import { startPreviewServers, previewSweepTick } from './preview';
import { installDispatcher, dashboardBackedOff } from './dashboard-http';
import { assertRequiredConfig } from './config';
import { TickLog } from './tick-log';

// This process DRIVES tmux; it is never inside it. Scrub any inherited TMUX vars
// before anything can shell out.
//
// They get inherited when the gateway is first started from a tmux pane: pm2 captures
// the environment, `pm2 save` writes it to dump.pm2, and every later `pm2 resurrect`
// restores it — including a $TMUX pointing at that long-dead server. While the machine
// stays up the socket happens to still exist, so nothing looks wrong; a reboot kills
// the server and the pointer goes stale.
//
// The failure it causes is silent and total: with a dead $TMUX, `tmux new-session -d`
// EXITS 0 AND CREATES NOTHING. The gateway believes every pane it asks for, delivers
// into a session that was never created, and every message to that machine stops
// arriving ("sendKeys failed: tmux session not found"). The browser terminal inherits
// the same env and shows "error creating /private/tmp/tmux-501/default". Cost sway003
// its entire message path after a reboot on 2026-08-05, and the Mac had the identical
// value sitting in its dump waiting for the next one.
delete process.env.TMUX;
delete process.env.TMUX_PANE;

// Own this process's outbound HTTP policy explicitly, and do it here — in the
// module BODY, so it runs after every import's side effects and wins over any
// dependency that installs a global dispatcher of its own (pi-coding-agent
// does). Pins HTTP/1.1; see dashboard-http.ts for the two-day macmini003
// outage that motivated it.
installDispatcher();

// Before any work: refuse to run without the settings that have no safe
// default. This lives here rather than at config.ts import time because an
// import must not be able to kill the process — see assertRequiredConfig.
assertRequiredConfig();

console.log('[gateway] starting');

// What the ~20 periodic loops are allowed to say. A routine success is silent;
// slow, failed and recovered each keep their line, and a rollup every few
// minutes reports the rest. See ./tick-log for the 17.5MB/day this replaces.
const tickLog = new TickLog(Date.now());

async function safe(label: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    const line = tickLog.ok(label, Date.now() - t0, Date.now());
    if (line) console.log(line);
  } catch (e) {
    const line = tickLog.error(label, e instanceof Error ? e.message : String(e), Date.now());
    if (line) console.error(line);
  }
}

// Deliberately NOT through loop(): that skips a tick while the dashboard is
// backed off, which is precisely the window in which "nothing ran" is the line
// worth having. Checked often, prints only when a window is up.
setInterval(() => {
  const line = tickLog.rollup(Date.now());
  if (line) console.log(line);
}, 30_000);

async function pushAgents() {
  await safe('agents', async () => {
    // DB-leader: the dashboard owns which agents exist + where they live.
    // We pull the (name, directory) pairs, read each directory's markdowns,
    // and push content updates. No filesystem scan of AGENTS_ROOT.
    const entries = await api.listAgentDirectories();
    const rows = collectAgentsFromList(entries);
    if (rows.length === 0) return;
    await api.syncAgents(rows);
  });
}

async function pushGlobalSkillsTick() {
  await safe('global-skills', async () => { await pushGlobalSkills(); });
}

// Idempotent brain convergence (issue #1): on every startup (and a low-freq
// fallback), ask the dashboard to reconcile this machine's orchestrator — bring
// an out-of-date brain up to the current template (the `dreaming` skill), ensure
// its Daily dream cron, and trigger the first dream. No-op when there's no brain
// (opt-in). Runs after pushAgents so the brain's `directory` is freshly synced
// (the dream-trigger gate needs it). The skill overlay it queues is materialized
// by the agent-requests tick; the version stamps when we ack that overlay.
async function ensureBrainTick() {
  await safe('ensure-brain', async () => {
    const r = await api.ensureBrain();
    if (r?.name) console.log(`[ensure-brain] reconciled orchestrator: ${r.name}`);
  });
}

// Scrape the REAL Claude Max plan % from `claude /usage` (throwaway tmux pane)
// and push it. The only accurate source — ccusage is a cost estimate that never
// matches /usage. Each run spins a ~20s claude session + one minimal API call,
// so it runs infrequently.
async function pushPlanUsage() {
  await safe('plan-usage', async () => {
    const pu = await collectPlanUsage();
    if (pu) await api.syncPlanUsage(pu);
  });
}

// Codex plan consumption from its official app-server rate-limit method, plus
// per-day tokens from rollout files. The short-lived app-server creates no
// thread or model turn; it only reads the authenticated account snapshot.
// Returns whether a non-null sample was actually synced, so the startup
// sequence can say so once (the ticks themselves stay silent — tick-log.ts).
async function pushCodexUsage(): Promise<boolean> {
  let synced = false;
  await safe('codex-usage', async () => {
    const cu = await collectCodexUsage();
    // A failed live read returns null. Skipping preserves the last good row
    // instead of replacing both quota cards with blanks.
    if (cu) {
      await api.syncCodexUsage(cu);
      synced = true;
    }
  });
  return synced;
}

// Kimi Code subscription quota, straight from Moonshot's own `/v1/usages`.
// One HTTP GET, no process and no scraping — but it is a NETWORK call to a
// third party, so it rides the slow loop rather than the 2s tick.
async function pushKimiUsage() {
  await safe('kimi-usage', async () => {
    const ku = await collectKimiUsage();
    // null = this machine has no Kimi credential (or the endpoint refused).
    // Skipping leaves the row absent, which is what makes the dashboard hide
    // the panel rather than render an empty one.
    if (ku) await api.syncKimiUsage(ku);
  });
}

async function globalSkillReqTick() {
  await safe('global-skill-requests', async () => { await globalSkillRequestTick(); });
}

async function pushSessionSnapshots() {
  await safe('session-snapshots', async () => {
    const items = await collectSessionSnapshots();
    if (items.length === 0) return;
    await api.syncSessionSnapshots(items);
  });
}

async function pushHostStat() {
  await safe('host-stat', async () => {
    await api.syncHostStat(await collectHostStat());
  });
}

async function pushUsage() {
  await safe('usage', async () => {
    const DAYS = 35;
    const items = await collectUsage(DAYS);
    // Nothing collected means ccusage failed, not that usage is zero — send nothing,
    // and in particular do NOT ask the dashboard to replace the window with nothing.
    if (items.length === 0) return;
    const batch = 50;
    for (let i = 0; i < items.length; i += batch) {
      // The FIRST batch carries the replace boundary: the dashboard clears the window
      // and takes this run as its truth (see usageWindowStart — an upsert-only writer
      // kept every day's copy of a live session's running total). Later batches just
      // add to the window this one opened.
      await api.syncUsage(items.slice(i, i + batch), i === 0 ? usageWindowStart(DAYS).toISOString() : undefined);
    }
  });
}

async function pushUsageWindows() {
  await safe('windows', async () => {
    const items = await collectUsageWindows();
    if (items.length > 0) {
      await api.syncUsageWindows(items);
    }
  });
}

async function pushCronTick() {
  await safe('cron-tick', async () => {
    await cronTick();
  });
}

async function pushChatTick() {
  await safe('chat-tick', async () => {
    await chatTick();
  });
}

async function pushChatCancelTick() {
  await safe('chat-cancel-tick', async () => {
    await chatCancelTick();
  });
}

async function pushChatRestartTick() {
  await safe('chat-restart-tick', async () => {
    await chatRestartTick();
  });
}

// Brain dispatch-watcher: reactive loop that pokes the Brain when a dispatched
// agent blocks on a choice or finishes a turn (docs/brain-design.md Phase 2).
// All logic is server-side; we only tick it + log transitions.
async function pushDispatchWatch() {
  await safe('dispatch-watch', async () => {
    const r = await api.runDispatchWatch();
    if (r.poked > 0) console.log(`[dispatch-watch] poked brain about ${r.poked}/${r.scanned} dispatch(es)`);
  });
}

// Brain takeover-watcher: the same reactive loop for conversations the human handed
// to the Brain (docs/brain-takeover-design.md). Faster than the dispatch watcher —
// a takeover is a live conversation someone is watching, so a 30s gap between the
// agent replying and the Brain noticing would read as the Brain having stalled.
async function pushTakeoverWatch() {
  await safe('takeover-watch', async () => {
    const r = await api.runTakeoverWatch();
    if (r.poked > 0) console.log(`[takeover-watch] poked brain about ${r.poked}/${r.scanned} takeover(s)`);
    if (r.ended > 0) console.log(`[takeover-watch] released ${r.ended} takeover(s) whose session closed`);
  });
}

// While the dashboard is unreachable at the transport level, skip ticks outright
// instead of running them into a throw. Every one of these ticks is a dashboard
// call, and firing them anyway is what produced 1732 log lines/minute for 28
// hours on macmini003 (and a 911MB out.log). The breaker reopens on its own
// schedule, so recovery still gets probed — see dashboard-http.ts.
// Set the moment a stop signal arrives. Every periodic tick checks it, so the
// drain below is not racing the chat tick to deliver one more user message into
// a child that is about to be closed.
let stopping = false;

function loop(fn: () => Promise<void>, ms: number) {
  setInterval(() => {
    if (stopping) return;
    if (dashboardBackedOff()) return;
    fn().catch(() => {});
  }, ms);
}

// Initial run kicks all uploaders ASAP so the dashboard isn't empty.
(async () => {
  // First, before anything resumes anything: reap the agent children the
  // PREVIOUS gateway orphaned. A codex exec holds its thread's writer lock, so
  // every resume fails on "already has an active writer" until it dies; a
  // claude child holds nothing at all, which is worse — the resume SUCCEEDS and
  // two Claude Codes append to one transcript. Wait (briefly) for the SIGTERMs
  // to land so the first resume can't race either one.
  await safe('orphan-child', () => orphanChildReaperTick(1500));
  // Say so if pm2 is not running us the way the shutdown path needs. Costs one
  // `pm2 jlist`; buys us not shipping a graceful shutdown that silently never
  // gets to run.
  await safe('pm2-config', () => checkPm2Config('hermit-ui-gateway', SHUTDOWN_BUDGET_MS));
  // Then, before the first snapshot can report them dead: bring back the
  // sessions the last gateway was in the middle of. Tracking is armed FIRST so
  // the turns this pass itself starts are recorded too — a second restart while
  // a resumed turn is running has to resume it again.
  startTrackingInFlightTurns();
  // Sessions the host kept running come FIRST, and they cost nothing — nothing
  // is spawned, we just start listening to children that never stopped. Only
  // then the ones that were genuinely cut, which do cost a process each.
  await safe('session-host', reattachHostSessions);
  await safe('interrupted-turns', recoverInterruptedTurns);
  await pushAgents();
  await ensureBrainTick(); // after pushAgents: the brain's directory is fresh
  await pushGlobalSkillsTick();
  await safe('knowledge-reconcile', reconcileKnowledgeOnStartup); // converge attached KBs disk↔DB
  await safe('global-memory', globalMemoryTick);
  // One-time convergence: promote the legacy .env endpoint knobs into the
  // dashboard config so Settings → Pi Runtime shows what this machine actually
  // runs, instead of an empty form over a live .env. No-op once configured.
  await safe('pi-config-seed', seedPiConfigFromEnv);
  await pushSessionSnapshots();
  await pushHostStat();
  await pushUsage();
  await pushUsageWindows();
  await pushCronTick();
  // One startup line an acceptance check can grep for: it proves THIS process
  // made a non-null quota read, which a silent tick and the rollup cannot.
  if (await pushCodexUsage()) console.log('[codex-usage] ok');
  await pushKimiUsage();
  await pushPlanUsage(); // last — runs after the blocking ccusage scans, not starved by them
})();

// Turn boundaries reach the dashboard the instant the backend sees them, instead
// of waiting out the 8s snapshot tick and then the browser's 5s poll. Costs one
// tiny UPDATE per turn start and per turn end; everything expensive stays on the
// 8s tick. Not a loop — it subscribes, so it has to be wired before any session
// can run. See collect/session-state-push.ts.
startSessionStatePush();

// Hourly, and silent unless Anthropic's paused Agent-SDK billing split comes
// back. A control request against a session that is already running, so it costs
// nothing; see collect/sdk-bucket.ts for what it watches and why it has to.
loop(() => safe('sdk-bucket', sdkBucketTick), 60 * 60_000);

// Persistent outbound control WebSocket to the dashboard for the browser
// terminal feature. Fires-and-reconnects-forever; no loop needed.
startControlChannel();

// Localhost WS server the Chrome extension connects to — a generic command
// channel to drive the user's real Chrome for browser automation. No-op until
// the extension connects. (The account auto-login feature was removed.)
startLoginBridge();

// Live preview: serve (:4180, tunneled to preview.swaylab.ai) + admin (:4181,
// loopback-only, the hermit-preview CLI's endpoint). See src/preview/.
startPreviewServers();

loop(pushAgents, 5 * 60_000);
loop(ensureBrainTick, 5 * 60_000); // fallback for brains created/updated between restarts
loop(pushSessionSnapshots, 8_000);
loop(pushHostStat, 30_000); // host RAM/swap/load → HostStat (resource governance)
loop(pushCronTick, 15_000);
loop(pushChatTick, 2_000);
loop(pushChatCancelTick, 1_500);
loop(pushChatRestartTick, 2_000);
loop(pushDispatchWatch, 30_000); // reactive Brain poke on dispatch block/finish
loop(pushTakeoverWatch, 8_000); // reactive Brain poke on takeover block/finish + cap sweep
loop(() => safe('hibernate-tick', chatHibernateTick), 3_000); // manual hibernate requests
loop(() => safe('chrome-reaper', chromeReaperTick), 5 * 60_000); // reap idle per-agent Chrome (~1GB each) the session-reaper leaves orphaned
loop(() => safe('stray-reaper', strayReaperTick), 5 * 60_000); // kill NON-owned leaked headless browsers (age + count caps) — the bound a leaking script's own watchdog cannot be trusted to provide (2026-08-26, load 237 on sway003-macmini)
loop(() => safe('cpu-reaper', cpuReaperTick), 5 * 60_000); // kill ORPHANED processes pinned at ≥90% of one core for hours (2026-08-29, 8 `while :; do :; done` loops ran 12 days, load 8.4)
loop(() => safe('cleanup-sweep', async () => {
  const r = await api.runCleanupSweep();
  if (r?.archived) console.log(`[cleanup-sweep] archived ${r.archived}`);
}), 10 * 60_000); // archive long-idle sessions — out of the sidebar AND asleep. Replaced the
// separate idle-reaper tick: same 10 min beat, but one mechanism instead of two with
// different thresholds. No-op unless the machine has cleanupIdleDays set.
loop(() => safe('session-purge', sessionPurgeTick), 10 * 60_000); // delete recycle-bin sessions past retention (confirmed released by every backend first)
loop(() => safe('orphan-pane', orphanPaneReaperTick), 10 * 60_000); // kill hermit-* panes no DB row accounts for (deleted sessions leak ~500MB each)
loop(() => safe('orphan-child', orphanChildReaperTick), 10 * 60_000); // kill the agent children a dead gateway left behind: a codex exec holds its thread's writer lock (2026-08-29), a claude child would double-write its transcript (2026-09-02)
loop(() => safe('agent-requests', agentRequestTick), 3_000);
loop(() => safe('machine-requests', machineRequestTick), 3_000);
loop(() => safe('file-transfers', fileTransferTick), 4_000);
loop(pushGlobalSkillsTick, 60_000);
loop(globalSkillReqTick, 3_000);
loop(() => safe('knowledge-requests', knowledgeRequestTick), 3_000);
loop(() => safe('global-memory', globalMemoryTick), 30_000);
// Real plan % via `claude /usage` scrape — every 12 min (initial run is the last
// step of the startup IIFE above, so it isn't starved by the ccusage block).
loop(pushPlanUsage, 12 * 60_000);
loop(async () => { await pushCodexUsage(); }, 12 * 60_000); // one short-lived app-server account read; no model turn
loop(pushKimiUsage, 12 * 60_000); // one GET to Moonshot; no-op on a machine with no Kimi credential
// Usage is the dashboard's only source for spend numbers (the live ccusage
// shell-out was removed). 30 min keeps ccusage's stdin scan light while still
// showing fresh-enough data for human-paced quota watching.
loop(pushUsage, 30 * 60_000);
loop(pushUsageWindows, 30 * 60_000);
loop(() => safe('preview-sweep', previewSweepTick), 60 * 60_000); // retire live previews idle past their 24h TTL

// How long a turn in flight may keep running once a stop signal has arrived.
//
// The whole shutdown has to fit inside pm2's `kill_timeout` or pm2 SIGKILLs us
// mid-drain and we are back to exactly the behaviour this replaces. The wait is
// only ONE of six phases — see shutdownBudgetMs(), which is the single place
// that adds them up, because this arithmetic was previously written out by hand
// in three files and was wrong in two of them.
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  // A typo (`14s`) yields NaN, and NaN silently disables the phase it bounds:
  // `now() < NaN` is false, so the wait would be skipped without a word.
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[gateway] ${name}=${JSON.stringify(raw)} is not a number of milliseconds; using ${fallback}`);
    return fallback;
  }
  return n;
}

const DRAIN_BUDGET_MS = envMs('HERMIT_DRAIN_BUDGET_MS', 14_000);
const FLUSH_BUDGET_MS = envMs('HERMIT_FLUSH_BUDGET_MS', 3_000);
const SHUTDOWN_BUDGET_MS = shutdownBudgetMs({ budgetMs: DRAIN_BUDGET_MS, flushMs: FLUSH_BUDGET_MS });

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return; // pm2 sends SIGINT then SIGKILL; a second signal must not restart the drain
  shuttingDown = true;
  stopping = true;
  // Before the drain interrupts anything: stop mirroring turn boundaries. Each
  // interrupt announces its session as idle, and left running the tracker would
  // erase the list of cut turns one entry at a time, right as we assemble it.
  freezeInFlightTurns();
  console.log(`[gateway] ${signal}, draining`);

  // The order matters and each step earns its place:
  //
  // 1. Stop the watchers first (they only read), so nothing re-attaches a tail
  //    to a session we are about to close.
  try { shutdownChatRunner(); } catch {}

  // 2. Let the turns that are running finish, tell the ones that cannot, and
  //    close every child — ALL backends, not just claude-sdk. Before this,
  //    `shutdownClaudeSdk()` was the whole of it: codex/kimi/dsh children were
  //    orphaned to keep writing session files the next gateway resumes from.
  const report = await drainSessions(
    {
      runtimes: allRuntimes(),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      postNotice: async (sessionId, externalId, text) => {
        await api.syncChatMessages([
          { sessionId, role: 'system', content: [{ type: 'text', text }], externalId },
        ]);
      },
      log: (line) => console.log(line),
    },
    { budgetMs: DRAIN_BUDGET_MS, stampMs: Date.now() },
  ).catch((e) => {
    console.error('[shutdown] drain failed:', e);
    return null;
  });

  // Hand the next gateway the list of turns this one cut, so it can pick them
  // back up instead of leaving a session that was mid-job silently stopped.
  // A drain that threw records nothing rather than a wrong list: the tracker's
  // own file is then the fallback, and it is at worst one boundary stale.
  if (report) recordInterruptedTurns(report.cutSessionIds, report.heldSessionIds);

  // 3. Belt and braces: any handle the drain could not name still gets closed.
  try { shutdownClaudeSdk(); } catch {}

  // 4. Only now push the buffered rows. Everything above produces some — the
  //    cut notices, each backend's own interrupt row, the last blocks of a turn
  //    that finished during the wait — and the old synchronous exit dropped up
  //    to a debounce window of them, uuid stamps included.
  await flushAllSyncBuffers(FLUSH_BUDGET_MS).catch(() => undefined);

  try { shutdownControlChannel(); } catch {}
  console.log('[gateway] exiting');
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
