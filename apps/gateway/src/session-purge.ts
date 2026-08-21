// session-purge.ts — the last rung of session cleanup: actually delete a session
// whose time in the recycle bin is up (docs/session-cleanup-design.md).
//
// The whole reason this lives in the gateway rather than in a dashboard mutation
// is the ONE invariant that makes bulk cleanup safe:
//
//     never delete a row anything is still holding.
//
// Deleting a row is what strands a ~500MB claude forever — every path that could
// kill the process is driven by that row (see orphan-pane-reaper.ts). Only the
// machine itself can see whether it is really gone, so the sequence is
// trash → hibernate → confirm dead → delete, and the confirmation step happens
// here. A session still held is hibernated and left for the next tick; it is
// never both killed and deleted in the same pass, so a crash between the two
// leaves the recoverable state, not the leaked one.
//
// "Still alive" was read as `tmuxSessionExists` for as long as a pane was the
// only way a session could run. On claude-sdk that is false for every session,
// always — so this gate, the whole reason the step lives in the gateway, was
// answering "nothing is holding it" without ever looking. See ./session-busy.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { api } from './api';
import { hibernateOneSession } from './chat-runner';
import { sessionIsHeld } from './session-busy';
import { PROJECTS_ROOT } from './config';

/**
 * Delete a session's claude transcript — the only place in this codebase allowed
 * to remove a file from the projects dir.
 *
 * `~/.claude/projects` is not ours. It holds every claude run on the host,
 * including the ones the human types in a terminal (1,923 files / 1.8 GB on
 * mac001, the vast majority never touched by hermit). So neither age nor location
 * can justify a delete. Three conditions must ALL hold, and any doubt is a skip:
 *
 *   1. the path came off the session row we are purging (never a directory scan),
 *   2. it resolves inside PROJECTS_ROOT,
 *   3. its basename is exactly the claude uuid that row recorded.
 *
 * (3) is what makes this safe rather than merely careful: it means we only delete
 * a file we can prove was written for this session.
 */
export function deleteTranscript(transcriptPath: string | null, claudeSessionId: string | null): boolean {
  if (!transcriptPath || !claudeSessionId) return false;
  const resolved = path.resolve(transcriptPath);
  const root = path.resolve(PROJECTS_ROOT);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;
  if (path.basename(resolved) !== `${claudeSessionId}.jsonl`) return false;
  try {
    fs.unlinkSync(resolved);
    return true;
  } catch {
    return false; // already gone, or not ours to remove
  }
}

export async function sessionPurgeTick(): Promise<void> {
  let due: Awaited<ReturnType<typeof api.pollPurgeDue>>;
  try {
    due = await api.pollPurgeDue();
  } catch {
    return; // dashboard blip — nothing is time-critical about a purge
  }
  if (due.length === 0) return;

  const purged: string[] = [];
  let files = 0;
  let deferred = 0;
  for (const row of due) {
    // Something still holds it: hibernate (full teardown — watcher, in-memory
    // state, child process, pane) and leave the row for the next tick. Deleting
    // now is exactly the bug this pipeline exists to prevent.
    if (await sessionIsHeld(row)) {
      await hibernateOneSession(row.id).catch(() => false);
      deferred++;
      continue;
    }
    if (deleteTranscript(row.transcriptPath, row.claudeSessionId)) files++;
    purged.push(row.id);
  }

  if (purged.length > 0) {
    try {
      await api.ackPurged(purged);
    } catch {
      // The row survives and comes back next tick. The transcript is already gone,
      // which is the safe direction to fail in: a session missing its transcript
      // reads as an old session whose history rolled off, not as lost live state.
      console.error(`[purge] ack failed for ${purged.length} session(s) — retrying next tick`);
      return;
    }
    console.log(`[purge] purged ${purged.length} session(s), ${files} transcript(s)`);
  }
  if (deferred > 0) console.log(`[purge] ${deferred} session(s) were still held — hibernated, purging next tick`);
}
