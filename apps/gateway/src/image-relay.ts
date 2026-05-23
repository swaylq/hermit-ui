// Pull image blocks out of incoming ChatMessage content, fetch each into a
// local cache so the tmux-driven `claude` can Read them, and return paths to
// inject into the prompt.
//
// Why we need a local cache: tmux `send-keys` only carries text, so the user's
// image upload — which already lives at <DASHBOARD_URL>/uploads/<sid>/<uuid>.safe.<ext>
// — has to be re-materialized on the Mac filesystem before claude can Read it.
//
// The dashboard's /api/upload already wrote a 2000px-max sidecar, so we trust
// the .safe.* url and skip re-running sips. The .safe. naming convention is
// our guard against L4 (image-dim crash); if the URL doesn't include .safe.
// we still cache but log a warning.

import { mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { DASHBOARD_URL, ASST_KEY } from './config';

const CACHE_DIR = process.env.HERMIT_IMAGE_CACHE_DIR ?? '/tmp/hermit-ui-cache';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface ExtractedImage {
  url: string;
  mimeType: string | null;
  base64Data: string | null; // populated when source.type === 'base64'
}

/**
 * Walk a content blocks array (Anthropic-format) and return image blocks
 * normalized to { url, mimeType, base64Data }. Both `source.type === 'url'`
 * and `source.type === 'base64'` are accepted.
 */
export function extractImages(content: unknown): ExtractedImage[] {
  if (!Array.isArray(content)) return [];
  const out: ExtractedImage[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if ((block as any).type !== 'image') continue;
    const src = (block as any).source;
    if (!src || typeof src !== 'object') continue;
    if (src.type === 'url' && typeof src.url === 'string') {
      out.push({ url: src.url, mimeType: typeof src.media_type === 'string' ? src.media_type : null, base64Data: null });
    } else if (src.type === 'base64' && typeof src.data === 'string') {
      out.push({
        url: `data:${src.media_type || 'image/png'};base64,${(src.data as string).slice(0, 16)}…`,
        mimeType: typeof src.media_type === 'string' ? src.media_type : 'image/png',
        base64Data: src.data,
      });
    }
  }
  return out;
}

/** Derive a stable on-disk filename for a given image source. */
function cacheFilename(img: ExtractedImage): string {
  const key = img.base64Data
    ? `b64:${img.base64Data.slice(0, 1024)}`
    : `url:${img.url}`;
  const sha = createHash('sha256').update(key).digest('hex').slice(0, 32);
  // Prefer extension from the URL path, fall back to mime map, else .bin.
  let ext = '';
  if (!img.base64Data) {
    const pathOnly = img.url.split('?')[0];
    const fromPath = extname(pathOnly).replace(/^\./, '').toLowerCase();
    if (/^(png|jpg|jpeg|gif|webp)$/.test(fromPath)) {
      ext = fromPath === 'jpeg' ? 'jpg' : fromPath;
    }
  }
  if (!ext && img.mimeType && EXT_BY_MIME[img.mimeType]) ext = EXT_BY_MIME[img.mimeType];
  if (!ext) ext = 'bin';
  return `${sha}.${ext}`;
}

/** Resolve a possibly-relative image URL against the dashboard host. */
function absoluteUrl(url: string): string {
  if (/^[a-z]+:/i.test(url)) return url;
  // Strip trailing slash on DASHBOARD_URL just in case.
  return DASHBOARD_URL.replace(/\/+$/, '') + (url.startsWith('/') ? url : `/${url}`);
}

/** True if the file already sits in the cache. */
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/**
 * Download (or write, if base64) the image into the cache. Returns the local
 * absolute path. Idempotent: same image hash → same path → skipped if present.
 */
export async function ensureCached(img: ExtractedImage): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const filename = cacheFilename(img);
  const out = join(CACHE_DIR, filename);
  if (await exists(out)) return out;

  if (img.base64Data) {
    await writeFile(out, Buffer.from(img.base64Data, 'base64'), { mode: 0o644 });
    return out;
  }

  const full = absoluteUrl(img.url);
  // Watchdog: anything pulled from the dashboard's /uploads/ path was already
  // resized by /api/upload. Anything else is a wildcard — flag it.
  if (!img.url.includes('.safe.') && !full.includes('.safe.')) {
    console.warn(`[image-relay] caching non-safe image (no .safe. in path): ${full}`);
  }

  // X-Asst-Key in case the URL is behind dashboard auth — /uploads/ is open
  // currently but the header is harmless and future-proofs route auth.
  const r = await fetch(full, { headers: { 'x-asst-key': ASST_KEY } });
  if (!r.ok) {
    throw new Error(`download failed (${r.status}): ${full}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(out, buf, { mode: 0o644 });
  return out;
}

/**
 * For a batch of user ChatMessage content arrays, return:
 *   - successful   — list of local cache paths in delivery order
 *   - failed       — { url, error } for any that didn't cache
 * Callers prepend the successful paths to the tmux prompt as `Read <path>`.
 */
export async function relayImages(contents: unknown[]): Promise<{ paths: string[]; errors: Array<{ url: string; error: string }> }> {
  const all: ExtractedImage[] = [];
  for (const c of contents) all.push(...extractImages(c));
  if (all.length === 0) return { paths: [], errors: [] };

  const paths: string[] = [];
  const errors: Array<{ url: string; error: string }> = [];
  // Sequential to keep diagnostics readable; image counts are small (≤10).
  for (const img of all) {
    try {
      paths.push(await ensureCached(img));
    } catch (e) {
      errors.push({ url: img.url, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { paths, errors };
}
