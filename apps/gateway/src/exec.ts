// Async, non-blocking replacement for `spawnSync`.
//
// The gateway is single-threaded. A `spawnSync('npx', ['ccusage', ...])` froze
// the event loop for 15-44s per run, starving EVERY timer and in-flight fetch —
// chat polls timed out, plan-usage ticks never fired. `spawn` + await keeps the
// loop free while the child runs, so the same work no longer stalls anything.

import { spawn } from 'node:child_process';

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function execCapture(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    } catch {
      resolve({ status: null, stdout: '', stderr: '', timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch {}
        }, opts.timeoutMs)
      : null;

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const done = (status: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}
