// Generate the 640px WebP thumbnail that `lib/thumb-url.ts` points at.
//
// Two callers: `/api/upload` writes one eagerly for every new image, and
// `/uploads/[...path]` writes one on demand the first time an older image's
// thumbnail is requested (so the ~3.2k images already on disk need no backfill
// to benefit, though `scripts/backfill-thumbs.sh` warms them anyway).
//
// Cost measured on the deploy box (4 vCPU): 113 ms for a 1.9 MB PNG. Written to
// a temp file and renamed, so two concurrent requests for the same missing
// thumbnail cannot serve a half-written file.

import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const THUMB_LONG_EDGE = 640;
export const THUMB_QUALITY = 75;

const whichCache = new Map<string, string | null>();
function which(bin: string): string | null {
  const hit = whichCache.get(bin);
  if (hit !== undefined) return hit;
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  const path = r.status === 0 ? r.stdout.trim() : null;
  whichCache.set(bin, path);
  return path;
}

/**
 * Write a ≤640px WebP of `inPath` to `outPath`. Returns true only if the file
 * is really there afterwards. Best-effort by design: a false here means the
 * client keeps using the full-size `.safe.` URL, which is the old behaviour,
 * never a broken image.
 */
export function makeThumb(inPath: string, outPath: string): boolean {
  if (!existsSync(inPath)) return false;
  // The temp name ends in `.tmp`, and imagemagick picks its OUTPUT FORMAT from
  // the output extension — so writing to `x.tmp` and renaming to `x.thumb.webp`
  // produced a 407KB 16-bit PNG wearing a .webp name (measured in production,
  // 2026-08-25). The `webp:` prefix states the format explicitly and does not
  // care what the file is called.
  const tmp = `${outPath}.${randomUUID().slice(0, 8)}.tmp`;
  const ok = (() => {
    // imagemagick first — it is what the Linux deploy box has, and `[0]` pins
    // the first frame so a multi-frame source can't produce a surprise.
    if (which('convert')) {
      const r = spawnSync(
        'convert',
        [
          `${inPath}[0]`,
          '-resize', `${THUMB_LONG_EDGE}x${THUMB_LONG_EDGE}>`,
          // 16-bit sources stay 16-bit otherwise, and colour profiles / EXIF ride
          // along; neither survives a 320px box usefully.
          '-depth', '8',
          '-strip',
          '-quality', String(THUMB_QUALITY),
          `webp:${tmp}`,
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      if (r.status === 0 && existsSync(tmp)) return true;
    }
    // macOS dev boxes: sips can write webp on macOS 13+. If it can't, we return
    // false and nothing downstream breaks.
    if (which('sips')) {
      const r = spawnSync(
        'sips',
        ['-Z', String(THUMB_LONG_EDGE), '-s', 'format', 'webp', '-s', 'formatOptions', String(THUMB_QUALITY), inPath, '--out', tmp],
        { encoding: 'utf8', timeout: 20_000 },
      );
      if (r.status === 0 && existsSync(tmp)) return true;
    }
    return false;
  })();
  if (!ok) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    return false;
  }
  try {
    renameSync(tmp, outPath);
    return true;
  } catch {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    return false;
  }
}
