// Fire SystemTasks fetched from the dashboard. Same logic that previously ran
// in dashboard/src/server/scheduler.ts, refactored to push results back via
// the sync API instead of mutating the DB directly.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AGENTS_ROOT } from './config';
import { api } from './api';

const HAPPY_BIN = '/opt/homebrew/bin/happy';
const PROMPT_TIMEOUT_MS = 30 * 60_000;
const LOG_TAIL_BYTES = 4096;
const LOG_DIR = '/Users/mac/claudeclaw/asst/gateway/task-logs';

fs.mkdirSync(LOG_DIR, { recursive: true });

const running = new Set<string>();

type Task = {
  id: string;
  name: string;
  agentName: string;
  directory: string | null;
  prompt: string;
  intervalSec: number;
  enabled: boolean;
  happySessionId: string | null;
  lastFire: string | null;
  lastStatus: string | null;
};

// Tasks whose previous fire exceeded this age while still in `running` status
// are presumed dead (gateway was killed mid-run) and reclaimed.
const STALE_RUNNING_MS = PROMPT_TIMEOUT_MS + 5 * 60_000;

export async function tick() {
  let tasks: Task[];
  try {
    tasks = (await api.listSystemTasks()) as Task[];
  } catch (e) {
    console.error('[scheduler] listSystemTasks failed:', e);
    return;
  }
  const now = Date.now();
  for (const t of tasks) {
    if (!t.enabled) continue;
    if (running.has(t.id)) continue;

    // Recover stale `running` tasks: previous run is older than our hard
    // timeout, so the gateway either died mid-execution or the child was
    // orphaned. Mark fail + lastFire so it gets re-evaluated below.
    if (t.lastStatus === 'running') {
      const lastMs = t.lastFire ? new Date(t.lastFire).getTime() : 0;
      if (now - lastMs > STALE_RUNNING_MS) {
        console.log('[scheduler] reclaiming stale running task', t.name);
        await api
          .taskResult({
            id: t.id,
            status: 'fail',
            output: '[reclaimed] previous run exceeded timeout — gateway probably crashed',
            durationMs: now - lastMs,
            happySessionId: t.happySessionId,
            lastFire: new Date(lastMs).toISOString(),
          })
          .catch((e) => console.error('[scheduler] reclaim post failed:', e));
        // Don't fire this tick — let the next listSystemTasks reflect the new
        // status before the eligibility check runs again.
        continue;
      }
      continue;
    }
    const lastMs = t.lastFire ? new Date(t.lastFire).getTime() : 0;
    if (now - lastMs < t.intervalSec * 1000) continue;
    fire(t).catch((e) => console.error('[scheduler] fire error', t.name, e));
  }
}

async function fire(t: Task) {
  running.add(t.id);
  const startedAt = new Date();
  // Mark running so subsequent ticks skip this task.
  await api
    .taskResult({ id: t.id, status: 'running', lastFire: startedAt.toISOString() })
    .catch(() => {});

  const dir = t.directory || path.join(AGENTS_ROOT, t.agentName);
  const logPath = path.join(LOG_DIR, `${t.name}-${startedAt.getTime()}.log`);
  console.log('[scheduler] fire', t.name, 'in', dir);

  const args = ['--yolo'];
  if (t.happySessionId) args.push('--continue');
  args.push('-p', t.prompt);

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const exitCode = await new Promise<number>((resolve) => {
    // happy 1.1.9 with -p waits 3s for stdin before proceeding, even when we
    // never plan to send anything. Open stdin and end() it immediately so
    // happy short-circuits the wait and starts the prompt.
    const child = spawn(HAPPY_BIN, args, {
      cwd: dir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try { child.stdin?.end(); } catch {}
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5_000);
    }, PROMPT_TIMEOUT_MS);
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('exit', (code) => { clearTimeout(killer); resolve(code ?? -1); });
    child.on('error', (e) => { stderr += '\n[spawn-error] ' + String(e); resolve(-1); });
  });

  const elapsedMs = Date.now() - startedAt.getTime();
  const combined = stdout + (stderr ? '\n[stderr]\n' + stderr : '');
  try { fs.writeFileSync(logPath, combined); } catch {}
  const tail = combined.length > LOG_TAIL_BYTES ? combined.slice(-LOG_TAIL_BYTES) : combined;

  // Capture happy session id from stdout (e.g., "happySessionId: xxx") if first run.
  let sessionId: string | null = t.happySessionId;
  if (!sessionId) {
    const m = combined.match(/happySessionId[":\s]+([a-z0-9]{20,})/i);
    if (m) sessionId = m[1];
  }

  const status = timedOut ? 'fail' : exitCode === 0 ? 'ok' : 'fail';
  await api
    .taskResult({
      id: t.id,
      status,
      output: tail,
      durationMs: elapsedMs,
      happySessionId: sessionId,
      lastFire: startedAt.toISOString(),
    })
    .catch((e) => console.error('[scheduler] task-result post failed:', e));

  running.delete(t.id);
  console.log('[scheduler] done', t.name, status, elapsedMs, 'ms');
}
