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
//   cron tick           15 s   (fires due Cron jobs via tmux + claude)
//   chat tick           2  s
//   chat-cancel tick    1.5s
//   chat-restart tick   2  s
//   takeover watch      8  s  (reactive Brain poke while it drives a conversation
//                              the human handed over, + the cap sweep)
//   usage               30 min  (was 5 min — dashboard now relies on these
//                                pushes exclusively, no on-demand ccusage)

import { collectAgentsFromList } from './collect/agents';
import { collectSessionSnapshots } from './collect/session-snapshot';
import { collectHostStat } from './collect/host-stat';
import { collectUsage, usageWindowStart } from './collect/usage';
import { collectUsageWindows } from './collect/window';
import { collectPlanUsage } from './collect/plan-usage';
import { api } from './api';
import { tick as cronTick } from './cron-runner';
import { chatTick, chatCancelTick, chatRestartTick, chatHibernateTick, reaperTick, shutdownChatRunner } from './chat-runner';
import { agentRequestTick } from './agent-lifecycle';
import { machineRequestTick } from './machine-requests';
import { startLoginBridge } from './login-bridge';
import { fileTransferTick } from './file-station';
import { pushGlobalSkills, globalSkillRequestTick } from './global-skills';
import { knowledgeRequestTick, reconcileKnowledgeOnStartup } from './knowledge';
import { globalMemoryTick } from './global-memory';
import { seedPiConfigFromEnv } from './pi-config';
import { chromeReaperTick } from './chrome-reaper';
import { startControlChannel, shutdownControlChannel } from './control-channel';

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

console.log('[gateway] starting');

async function safe(label: string, fn: () => Promise<void>) {
  try {
    const t0 = Date.now();
    await fn();
    console.log(`[${label}] ok in ${Date.now() - t0}ms`);
  } catch (e) {
    console.error(`[${label}] error:`, e instanceof Error ? e.message : e);
  }
}

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

function loop(fn: () => Promise<void>, ms: number) {
  setInterval(() => {
    fn().catch(() => {});
  }, ms);
}

// Initial run kicks all uploaders ASAP so the dashboard isn't empty.
(async () => {
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
  await pushPlanUsage(); // last — runs after the blocking ccusage scans, not starved by them
})();

// Persistent outbound control WebSocket to the dashboard for the browser
// terminal feature. Fires-and-reconnects-forever; no loop needed.
startControlChannel();

// Localhost WS server the Chrome extension connects to — a generic command
// channel to drive the user's real Chrome for browser automation. No-op until
// the extension connects. (The account auto-login feature was removed.)
startLoginBridge();

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
loop(() => safe('reaper', reaperTick), 10 * 60_000); // auto-reap idle sessions (resource governance)
loop(() => safe('chrome-reaper', chromeReaperTick), 5 * 60_000); // reap idle per-agent Chrome (~1GB each) the session-reaper leaves orphaned
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
// Usage is the dashboard's only source for spend numbers (the live ccusage
// shell-out was removed). 30 min keeps ccusage's stdin scan light while still
// showing fresh-enough data for human-paced quota watching.
loop(pushUsage, 30 * 60_000);
loop(pushUsageWindows, 30 * 60_000);

function shutdown(signal: string) {
  console.log(`[gateway] ${signal}, exiting`);
  try { shutdownChatRunner(); } catch {}
  try { shutdownControlChannel(); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
