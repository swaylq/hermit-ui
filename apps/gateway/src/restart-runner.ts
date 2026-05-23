// Poll the dashboard for restart requests; for each, spawn the agent's
// restart.sh detached so it survives the gateway being SIGTERM'd by the agent
// it just restarted (which can happen if a user restarts asst — though asst
// isn't actually managed via tmux+restart.sh today, so that's a non-issue).
//
// State transitions on the dashboard:
//   restartRequestedAt: set       → UI shows "queued"
//   restartStartedAt:   set       → UI shows "restarting…"
//   both null                     → done, next agent push will overwrite pid

import { spawn } from 'node:child_process';
import path from 'node:path';
import { AGENTS_ROOT } from './config';
import { api } from './api';

const RESTART_HOLD_MS = 60_000; // Skip new fire if started <60s ago.

const lastFiredAt = new Map<string, number>(); // agent.id → ms

export async function restartTick() {
  let pending: Array<{ id: string; name: string; pid: number | null }>;
  try {
    pending = await api.listPendingAgentActions();
  } catch (e) {
    console.error('[restart] poll failed:', e);
    return;
  }
  const now = Date.now();
  for (const a of pending) {
    const recent = lastFiredAt.get(a.id);
    if (recent && now - recent < RESTART_HOLD_MS) continue;
    lastFiredAt.set(a.id, now);
    fire(a).catch((e) => console.error('[restart] fire error', a.name, e));
  }
}

async function fire(a: { id: string; name: string; pid: number | null }) {
  await api.ackAgentAction(a.id, 'started').catch(() => {});
  const dir = path.join(AGENTS_ROOT, a.name);
  const oldPid = a.pid != null ? String(a.pid) : '';
  console.log(`[restart] kicking restart.sh for ${a.name} (old pid=${oldPid || '?'})`);

  // restart.sh waits ~10s for tmux respawn + pid resolution. We detach so the
  // gateway moves on; restart.sh writes the new pid into agent.pid which the
  // next agents sync picks up. Stdio piped to /dev/null so we don't accumulate
  // open fds when many restarts happen.
  const child = spawn('/bin/bash', [path.join(dir, 'restart.sh'), oldPid], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // restart.sh forks tmux; we can't reliably know "done" — clear the action
  // after a short delay so the UI reverts the spinner.
  setTimeout(() => {
    api.ackAgentAction(a.id, 'done').catch(() => {});
  }, 12_000);
}
