// GET /uploads/<sessionId>/<uuid>.safe.<ext>
//
// Serves files written by /api/upload. Open by URL — the path is "secret-ish"
// (random uuid), no per-request auth check, but path-traversal is hard-blocked
// via resolve()+startsWith().
//
// In production the deploy script should drop a reverse proxy in front (caddy
// X-Sendfile / nginx alias) so Node never reads the file. This handler is the
// dev fallback + the no-reverse-proxy production fallback.

import { NextRequest } from 'next/server';
import { stat, readFile, open } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { platform } from 'node:os';

function uploadRoot(): string {
  const fromEnv = process.env.HERMIT_UPLOAD_DIR;
  if (fromEnv) return fromEnv;
  return platform() === 'linux' ? '/var/hermit-ui/uploads' : '/tmp/hermit-ui/uploads';
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  // audio — served with a real type so the chat can play it inline (<audio>).
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  // video — real type + Range support below so <video> streams + seeks (Safari
  // won't play a <video> at all without 206 Partial Content).
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await params;
  if (!parts?.length) return new Response('not found', { status: 404 });

  const root = uploadRoot();
  const rootResolved = resolve(root);
  const target = resolve(root, ...parts);
  // Path-traversal guard: refuse anything that escapes UPLOAD_DIR.
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    return new Response('forbidden', { status: 403 });
  }

  const st = await stat(target).catch(() => null);
  if (!st || !st.isFile()) return new Response('not found', { status: 404 });

  const mime = MIME_BY_EXT[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const total = st.size;
  const baseHeaders: Record<string, string> = {
    'content-type': mime,
    // Uuid path = effectively immutable; ok to cache hard.
    'cache-control': 'public, max-age=31536000, immutable',
    // Advertise range support so <audio>/<video> can seek.
    'accept-ranges': 'bytes',
  };

  // HTTP Range (RFC 7233): media elements request byte ranges to stream + seek —
  // Safari refuses to play a <video> that doesn't answer 206. Serve only the
  // requested slice (never buffer the whole file — videos can be up to 200MB).
  const rangeHeader = _req.headers.get('range');
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : NaN;
    let end = m[2] ? parseInt(m[2], 10) : NaN;
    if (Number.isNaN(start)) {
      // suffix range "bytes=-N" → the last N bytes
      const suffix = Number.isNaN(end) ? 0 : end;
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else if (Number.isNaN(end)) {
      end = total - 1;
    }
    if (start > end || start >= total) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, 'content-range': `bytes */${total}` } });
    }
    end = Math.min(end, total - 1);
    const length = end - start + 1;
    const fh = await open(target, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      return new Response(new Uint8Array(buf), {
        status: 206,
        headers: { ...baseHeaders, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(length) },
      });
    } finally {
      await fh.close();
    }
  }

  // No range: whole file. Buffered read (production should put caddy/nginx in
  // front so this handler never serves real traffic; the buffer avoids the
  // Node-stream/Web-stream `Readable.toWeb()` ceremony). Media clients almost
  // always send a Range, so this path is mostly images + explicit downloads.
  const bytes = await readFile(target);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...baseHeaders, 'content-length': String(total) },
  });
}
