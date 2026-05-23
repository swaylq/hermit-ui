// asst-gateway — long-running Mac-local process that pushes filesystem-derived
// state up to the VPS dashboard and fires SystemTasks against the local agent
// tree.
//
// Intervals are intentionally staggered so we don't tax the dashboard or
// burn ccusage runs needlessly:
//   agents       30s
//   tasks tick   15s
//   launchagents  5min
//   usage         5min

import { collectAgents } from './collect/agents';
import { collectLaunchAgents } from './collect/launchAgents';
import { collectUsage } from './collect/usage';
import { collectUsageWindows } from './collect/window';
import { api } from './api';
import { tick as taskTick } from './system-task-runner';
import { restartTick } from './restart-runner';
import { chatTick, chatCancelTick, shutdownChatRunner } from './chat-runner';

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

async function pushRestartTick() {
  await safe('restart-tick', async () => {
    await restartTick();
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

function loop(fn: () => Promise<void>, ms: number) {
  setInterval(() => {
    fn().catch(() => {});
  }, ms);
}

// Initial run kicks all uploaders ASAP so the dashboard isn't empty.
(async () => {
  await pushAgents();
  await pushLaunchAgents();
  await pushUsage();
  await pushUsageWindows();
  await pushTaskTick();
  await pushRestartTick();
})();

loop(pushAgents, 30_000);
loop(pushTaskTick, 15_000);
loop(pushRestartTick, 10_000);
loop(pushChatTick, 2_000);
loop(pushChatCancelTick, 1_500);
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
