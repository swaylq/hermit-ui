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

    // A timeout kills the child we spawned — and only that one. `bash -lc "git
    // pull"` has bash as the child and git as a GRANDCHILD, and the grandchild
    // inherits the stdout/stderr pipes: killing bash leaves those pipes open, so
    // 'close' (which waits for stdio EOF) never fires and this promise never
    // settles. A caller that guards itself with an `if (busy) return` then stops
    // running anything, for good, with no error and no log line.
    //
    // So: kill, and settle regardless a moment later. 'exit' is the child's own
    // death, which does arrive; the grace timer covers a child that cannot even
    // be killed. Whatever the grandchild had written by then is what the caller
    // gets, which is the honest answer to "this took too long".
    let hardSettle: NodeJS.Timeout | null = null;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch {}
          hardSettle = setTimeout(() => done(null), 3_000);
        }, opts.timeoutMs)
      : null;

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const done = (status: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardSettle) clearTimeout(hardSettle);
      resolve({ status, stdout, stderr, timedOut });
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
    // Only after a timeout: normally 'close' is the one to wait for, because it
    // is what guarantees the output has been read to the end.
    child.on('exit', (code) => { if (timedOut) done(code); });
  });
}
