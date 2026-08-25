// Thumbnail URL derivation for chat images.
//
// The chat renders an image in a box capped at 320 CSS px but, until this
// existed, pointed `<img src>` straight at the `.safe.` file — a ≤2000px
// original averaging 535 KB on the deploy box (3,219 files, 1.68 GB). Measured
// on 12 real uploads: re-encoded to 640px WebP q75 the same pictures average
// 16 KB. A session whose opening window holds 11 images went from ~6.6 MB of
// thumbnails to ~0.18 MB.
//
// The thumbnail URL is DERIVED from the image URL rather than carried in the
// message block, so every image already in the corpus gets one without a
// backfill of the database — the bytes are produced on first request by
// `/uploads/[...path]` and cached on disk from then on.
//
// 640px (not 320) because the box is 320 CSS px and a phone is a 2x/3x display;
// 640 keeps it crisp and still costs ~3% of the original.
//
// GIF is deliberately excluded: a WebP re-encode of an animated GIF either
// drops the animation or bloats past the original, and neither is an
// improvement.

export const THUMB_SUFFIX = '.thumb.webp';

const SAFE_IMAGE_RE = /^(\/uploads\/[^/]+\/[^/]+)\.safe\.(png|jpg|jpeg|webp)$/i;

/**
 * `/uploads/<sid>/<uuid>.safe.png` → `/uploads/<sid>/<uuid>.thumb.webp`.
 * Returns null for anything that isn't a thumbnail-able upload URL — data:
 * URLs, GIFs, non-image attachments, absolute URLs to other hosts. Callers
 * fall back to the original URL on null.
 */
export function thumbUrlFor(url: string): string | null {
  const m = SAFE_IMAGE_RE.exec(url);
  return m ? `${m[1]}${THUMB_SUFFIX}` : null;
}

/**
 * Inverse: given a thumbnail path, the `.safe.` sources it could have come
 * from, in preference order. Used server-side to generate a missing thumbnail
 * on demand — the extension isn't recoverable from the thumbnail name, so we
 * try each.
 */
export function thumbSourceCandidates(thumbPath: string): string[] {
  if (!thumbPath.endsWith(THUMB_SUFFIX)) return [];
  const stem = thumbPath.slice(0, -THUMB_SUFFIX.length);
  return ['png', 'jpg', 'jpeg', 'webp'].map((e) => `${stem}.safe.${e}`);
}
