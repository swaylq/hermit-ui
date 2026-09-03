// background-output.ts — the last line a background task has written, so the
// dashboard can say what it is DOING rather than only that it exists.
//
// Claude Code keeps a background task's stdout/stderr at
//   /tmp/claude-<uid>/<cwd with every non-alphanumeric char turned into '-'>/<session uuid>/tasks/<task id>.output
// (observed 2.1.258: `/Users/mac/claudeclaw/asst` → `-Users-mac-claudeclaw-asst`,
// `/private/tmp/bgprobe.rHoU` → `-private-tmp-bgprobe-rHoU`, `3_vqmc…` → `3-vqmc…`).
// A subagent's `.output` is a SYMLINK to its JSONL transcript — never tail that:
// one line of it is a wall of JSON, and the reader would be quoting the wrong
// thing. Anything that is not a plain file reads as "nothing yet".
//
// sway, 2026-09-03: "让用户可以看到 background 在做什么". The description names the
// task; this is the one line that shows whether it is moving.

import { lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const TAIL_BYTES = 4096;
export const OUTPUT_TAIL_MAX = 160;

export function backgroundOutputPath(cwd: string, sessionUuid: string, taskId: string): string {
  const enc = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return join(`/tmp/claude-${userInfo().uid}`, enc, sessionUuid, 'tasks', `${taskId}.output`);
}

/**
 * The last non-empty line of the file, capped, or null when there is nothing
 * readable yet. Reads at most the final 4KB; a chatty build log is exactly the
 * case this must stay cheap for, since it runs for every snapshot of every
 * session with background work.
 */
export function readOutputTail(path: string, maxChars = OUTPUT_TAIL_MAX): string | null {
  let fd: number | null = null;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size === 0) return null;
    fd = openSync(path, 'r');
    const len = Math.min(TAIL_BYTES, st.size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n').map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return null;
    return last.length > maxChars ? last.slice(0, maxChars - 1) + '…' : last;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}
