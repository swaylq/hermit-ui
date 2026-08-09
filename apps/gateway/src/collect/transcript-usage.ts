// collect/transcript-usage.ts — how much disk the claude transcripts take, and
// how much of it no session accounts for (docs/session-cleanup-design.md).
//
// REPORT ONLY. It never deletes anything, and that is a conclusion, not caution:
//
// The design sketched an "orphan transcript sweep" alongside the orphan-PANE
// sweep. Writing it made clear the two are not symmetrical. A pane is provably
// ours — the `hermit-` prefix is a name we chose. A transcript is not:
// ~/.claude/projects holds EVERY claude run on the host, and the human's own
// terminal sessions live in the very same per-directory folders as the agents'
// (they are, after all, run in the agent directories). Nothing on disk
// distinguishes them.
//
// The only safe rule — delete a transcript when we still hold the row that names
// it — can only be applied while the row exists, which is exactly what
// session-purge.ts does at purge time. After the row is gone there is no evidence
// left to act on, so a standalone sweep could only guess. Guessing here means
// deleting the human's own history.
//
// So the leftovers get counted, not collected. 1.8 GB across 1,923 files on
// mac001 (2026-08-09) is worth SEEING; it is not worth a heuristic.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { api } from '../api';
import { PROJECTS_ROOT } from '../config';

export interface TranscriptUsage {
  transcriptTotalMb: number;
  transcriptCount: number;
  /** Files no live session's transcriptPath points at. */
  transcriptOrphanMb: number;
  transcriptOrphanCount: number;
}

// Scanning ~2k files is cheap but pointless at the host-stat cadence (30s), and
// the number moves on the scale of days. One scan per day, memoized; host-stat
// carries whatever the memo holds, so no new route and no new tick.
const TTL_MS = 24 * 60 * 60_000;
let memo: { at: number; value: TranscriptUsage } | null = null;

function scanDir(dir: string, out: Array<{ file: string; size: number }>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scanDir(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        out.push({ file: full, size: fs.statSync(full).size });
      } catch {
        /* raced with a delete */
      }
    }
  }
}

export async function collectTranscriptUsage(force = false): Promise<TranscriptUsage | null> {
  if (!force && memo && Date.now() - memo.at < TTL_MS) return memo.value;

  const files: Array<{ file: string; size: number }> = [];
  scanDir(PROJECTS_ROOT, files);
  if (files.length === 0) return memo?.value ?? null;

  let referenced: Set<string>;
  try {
    referenced = new Set(
      (await api.knownSessions())
        .map((r) => r.transcriptPath)
        .filter((p): p is string => !!p)
        .map((p) => path.resolve(p)),
    );
  } catch {
    // Without the reference set every file would look unreferenced. Report the
    // total and leave the orphan figure at what it was — a scary wrong number is
    // worse than a stale right one.
    return memo?.value ?? null;
  }

  const MB = 1024 * 1024;
  let totalBytes = 0;
  let orphanBytes = 0;
  let orphanCount = 0;
  for (const f of files) {
    totalBytes += f.size;
    if (!referenced.has(path.resolve(f.file))) {
      orphanBytes += f.size;
      orphanCount++;
    }
  }

  const value: TranscriptUsage = {
    transcriptTotalMb: Math.round(totalBytes / MB),
    transcriptCount: files.length,
    transcriptOrphanMb: Math.round(orphanBytes / MB),
    transcriptOrphanCount: orphanCount,
  };
  memo = { at: Date.now(), value };
  return value;
}
