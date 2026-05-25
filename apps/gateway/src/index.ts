// hermit-ui gateway — long-running Mac-local process that pushes filesystem-
// derived state up to the dashboard's postgres and fires SystemTasks against
// the local agent tree.
//
// Intervals (staggered):
//   agents              5 min  (static folder metadata — markdowns barely churn)
//   session-snapshots   30 s   (per-ChatSession runtime: alive/pid/ctx/jsonl tail)
//   tasks tick          15 s
//   chat tick           2  s
//   chat-cancel tick    1.5s
//   chat-restart tick   2  s
//   launchagents        5 min
//   usage               5 min

import { collectAgents } from './collect/agents';
import { collectSessionSnapshots } from './collect/session-snapshot';
import { collectLaunchAgents } from './collect/launchAgents';
import { collectUsage } from './collect/usage';
import { collectUsageWindows } from './collect/window';
import { api } from './api';
import { tick as taskTick } from './system-task-runner';
import { chatTick, chatCancelTick, chatRestartTick, shutdownChatRunner } from './chat-runner';

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
    const agents = collectAgents();
    await api.syncAgents(agents);
  });
}

async function pushSessionSnapshots() {
  await safe('session-snapshots', async () => {
    const items = await collectSessionSnapshots();
    if (items.length === 0) return;
    await api.syncSessionSnapshots(items);
  });
}

async function pushLaunchAgents() {
  await safe('launchagents', async () => {
    const items = collectLaunchAgents();
    await api.syncLaunchAgents(items);
  });
}

async function pushUsage() {
  await safe('usage', async () => {
    const items = await collectUsage(35);
    if (items.length === 0) return;
    const batch = 50;
    for (let i = 0; i < items.length; i += batch) {
      await api.syncUsage(items.slice(i, i + batch));
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

async function pushTaskTick() {
  await safe('task-tick', async () => {
    await taskTick();
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

function loop(fn: () => Promise<void>, ms: number) {
  setInterval(() => {
    fn().catch(() => {});
  }, ms);
}

// Initial run kicks all uploaders ASAP so the dashboard isn't empty.
(async () => {
  await pushAgents();
  await pushSessionSnapshots();
  await pushLaunchAgents();
  await pushUsage();
  await pushUsageWindows();
  await pushTaskTick();
})();

loop(pushAgents, 5 * 60_000);
loop(pushSessionSnapshots, 30_000);
loop(pushTaskTick, 15_000);
loop(pushChatTick, 2_000);
loop(pushChatCancelTick, 1_500);
loop(pushChatRestartTick, 2_000);
loop(pushLaunchAgents, 5 * 60_000);
loop(pushUsage, 5 * 60_000);
loop(pushUsageWindows, 5 * 60_000);

function shutdown(signal: string) {
  console.log(`[gateway] ${signal}, exiting`);
  try { shutdownChatRunner(); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
