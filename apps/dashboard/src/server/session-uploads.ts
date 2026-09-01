// The files a conversation uploaded — and deleting them when the conversation
// itself is deleted (docs/session-cleanup-design.md, the purge rung).
//
// Everything a session ever attached lands in ONE directory, `<UPLOAD_DIR>/<sessionId>/`:
// composer uploads, and every agent-side `attach_file` / `attach_image`, which post
// to the same /api/upload with the same sessionId. That is what makes this safe to do
// by directory — there is no table saying which blob belongs to which message, but the
// path itself is that index.
//
// Nothing used to remove them. Purging freed the rows and the transcript and left the
// bytes on disk forever: on the deploy box, 2026-09-01, 65 directories / 347 MB whose
// sessions no longer existed at all, inside a 9.5 GB upload root.

import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { platform } from 'node:os';

/** Same resolution as app/api/upload/route.ts — deliberately identical, incl. the default. */
export function uploadRoot(): string {
  const fromEnv = process.env.HERMIT_UPLOAD_DIR;
  if (fromEnv) return fromEnv;
  return platform() === 'linux' ? '/var/hermit-ui/uploads' : '/tmp/hermit-ui/uploads';
}

// A session id is a cuid: lowercase alphanumerics, no separators, no dots. Enforced
// because this module ends in a recursive delete — an id that was ever '', '.' or
// '../..' would take the whole upload root with it, file-station's transfers included.
// The path check below is the second lock on the same door; both stay.
const SESSION_ID_RE = /^[a-z0-9]{16,40}$/;

function sessionDir(sessionId: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const root = resolve(uploadRoot());
  const dir = resolve(join(root, sessionId));
  if (dir === root || !dir.startsWith(root + sep)) return null;
  return dir;
}

/** Bytes this session is holding in the upload root. 0 if it never attached anything. */
export async function sessionUploadBytes(sessionId: string): Promise<number> {
  const dir = sessionDir(sessionId);
  if (!dir) return 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // no uploads for this session
  }
  const sizes = await Promise.all(
    names.map(async (n) => {
      const st = await stat(join(dir, n)).catch(() => null);
      return st?.isFile() ? st.size : 0;
    }),
  );
  return sizes.reduce((a, b) => a + b, 0);
}

/** Same, for a list — used by the recycle-bin view, so it is bounded by that page size. */
export async function sessionUploadBytesMany(sessionIds: string[]): Promise<Map<string, number>> {
  const pairs = await Promise.all(sessionIds.map(async (id) => [id, await sessionUploadBytes(id)] as const));
  return new Map(pairs);
}

/**
 * Delete the upload directories of sessions that are already gone from the DB.
 *
 * Call this AFTER the row is deleted, never before: a row that survived a failed
 * delete but lost its images is a broken conversation, while files left behind by a
 * crash in between are merely orphaned bytes — recoverable, and invisible until
 * someone sweeps. Fail in the direction that keeps the conversation intact.
 *
 * Never throws: a purge that already deleted the row must not be retried forever
 * because a directory was read-only.
 */
export async function deleteSessionUploads(sessionIds: string[]): Promise<{ dirs: number; bytes: number }> {
  let dirs = 0;
  let bytes = 0;
  for (const id of sessionIds) {
    const dir = sessionDir(id);
    if (!dir) continue;
    const size = await sessionUploadBytes(id);
    const exists = await stat(dir).then((s) => s.isDirectory(), () => false);
    if (!exists) continue;
    try {
      await rm(dir, { recursive: true, force: true });
      dirs++;
      bytes += size;
    } catch {
      // already gone, or not ours to remove
    }
  }
  return { dirs, bytes };
}
