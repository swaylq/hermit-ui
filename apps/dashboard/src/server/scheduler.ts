// SystemTask scheduler. Runs in the Next.js node process; ticks every 15s,
// fires any task whose lastFire + intervalSec < now. Each fire spawns
// `happy --yolo` (resume mode via --continue once a happy session has been
// recorded) in the task's target directory and captures output for the row's
// lastOutput field.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prisma } from './db';

const HAPPY_BIN = '/opt/homebrew/bin/happy';
const AGENTS_ROOT = '/Users/mac/claudeclaw';
const TICK_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000; // 30 min hard cap
const LOG_TAIL_BYTES = 4096;
const LOG_DIR = path.join(AGENTS_ROOT, 'asst/dashboard/task-logs');

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startScheduler() {
  if (started) return;
  // Defense in depth — also bail here if we're on a host without the Mac
  // agent tree (VPS). instrumentation.ts already guards but we don't trust
  // bundler inlining to keep that.
  if (!fs.existsSync(AGENTS_ROOT)) {
    console.log('[scheduler] skipped — no AGENTS_ROOT, read-only host');
    return;
  }
  started = true;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  console.log('[scheduler] starting, tick every', TICK_MS, 'ms');
  void tick();
  timer = setInterval(() => void tick(), TICK_MS);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

const running = new Set<string>(); // taskId currently spawned

async function tick() {
  const now = Date.now();
  let tasks;
  try {
    tasks = await prisma.systemTask.findMany({ where: { enabled: true } });
  } catch (e) {
    console.error('[scheduler] db error', e);
    return;
  }
  for (const t of tasks) {
    if (running.has(t.id)) continue;
    const last = t.lastFire?.getTime() ?? 0;
    if (now - last < t.intervalSec * 1000) continue;
    fire(t).catch((e) => console.error('[scheduler] fire error', t.name, e));
  }
}

function tailFile(p: string, bytes: number): string {
  try {
    const stat = fs.statSync(p);
    const fd = fs.openSync(p, 'r');
    const start = Math.max(0, stat.size - bytes);
    const len = Math.min(bytes, stat.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

type Task = Awaited<ReturnType<typeof prisma.systemTask.findMany>>[number];

async function fire(t: Task) {
  running.add(t.id);
  const startedAt = Date.now();
  await prisma.systemTask.update({
    where: { id: t.id },
    data: { lastFire: new Date(startedAt), lastStatus: 'running' },
  });

  const dir = t.directory || path.join(AGENTS_ROOT, t.agentName);
  const logPath = path.join(LOG_DIR, `${t.name}-${startedAt}.log`);
  console.log('[scheduler] fire', t.name, 'in', dir);

  const args = ['--yolo'];
  if (t.happySessionId) {
    // Continue most recent session in cwd. happy passes the --continue flag
    // through to claude; combined with -p the run is non-interactive.
    args.push('--continue');
  }
  args.push('-p', t.prompt);

  let stdoutBuf = '';
  let stderrBuf = '';
  let exitCode: number | null = null;
  let timedOut = false;

  await new Promise<void>((resolve) => {
    const child = spawn(HAPPY_BIN, args, {
      cwd: dir,
      env: { ...process.env, HAPPY_PUSH_LOG: logPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }, PROMPT_TIMEOUT_MS);

    child.stdout.on('data', (b) => { stdoutBuf += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderrBuf += b.toString('utf8'); });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      exitCode = code ?? null;
      resolve();
    });
    child.on('error', (e) => {
      stderrBuf += '\n[spawn-error] ' + String(e);
      resolve();
    });
  });

  const elapsedMs = Date.now() - startedAt;
  const combined = stdoutBuf + (stderrBuf ? '\n[stderr]\n' + stderrBuf : '');
  try {
    fs.writeFileSync(logPath, combined);
  } catch {}
  const tail = combined.length > LOG_TAIL_BYTES ? combined.slice(-LOG_TAIL_BYTES) : combined;

  // Try to capture happy session id from stdout. happy CLI prints things like
  // "Session: <id>" or includes it in JSON; if we miss it, lastFire-based resume
  // still works via --continue (most-recent-in-cwd).
  let sessionId = t.happySessionId;
  const sidMatch = combined.match(/happySessionId[":\s]+([a-z0-9]{20,})/i);
  if (!sessionId && sidMatch) sessionId = sidMatch[1];

  const status = timedOut ? 'fail' : exitCode === 0 ? 'ok' : 'fail';

  await prisma.systemTask.update({
    where: { id: t.id },
    data: {
      lastStatus: status,
      lastOutput: tail,
      lastDurationMs: elapsedMs,
      happySessionId: sessionId ?? t.happySessionId,
    },
  });
  running.delete(t.id);
  console.log('[scheduler] done', t.name, status, elapsedMs, 'ms');
}
