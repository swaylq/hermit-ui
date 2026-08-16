// The tunneled byte path of live preview: 127.0.0.1:PREVIEW_SERVE_PORT, exposed
// publicly as https://preview.swaylab.ai via rathole + Caddy (+xray). Serves a
// registered static directory or transparently proxies a registered loopback
// service — including WebSocket upgrades, so vite/next HMR passes through.
//
// URL space:
//   /p/<previewId>/…            the canonical, capability-scoped world
//   /p/<previewId>/__hermit__/sse   auto-reload event stream (reload.ts)
//   anything unprefixed         dev servers use absolute paths (/src/main.tsx);
//                               we resolve the preview via Referer → cookie →
//                               sole-active and 307 back into the prefix, so
//                               deeper references land prefixed on their own.
//
// This port is reachable from the public internet through the tunnel, so treat
// every request as hostile: the only files that can leave are under a
// registered static root (realpath-contained, dotfiles refused), and the only
// sockets that can be reached are the loopback targets pinned at registration.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { PREVIEW_SERVE_PORT } from '../config';
import { getById, soleEntry, touch, type PreviewEntry } from './registry';
import { addSseClient, injectIntoHtml } from './reload';

const MAX_INJECT_BYTES = 2 * 1024 * 1024; // HTML bigger than this streams raw, uninjected
const COOKIE = 'hermit_pv';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function mimeFor(p: string): string {
  const ext = path.extname(p).slice(1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

function textResponse(res: http.ServerResponse, status: number, body: string, extra?: Record<string, string>) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(body);
}

function notFound(res: http.ServerResponse) {
  textResponse(res, 404, '<!doctype html><meta charset="utf-8"><title>404</title><p style="font:14px system-ui;color:#666;padding:2em">预览不存在或已过期（hermit live preview）</p>');
}

// ── request identity resolution ──────────────────────────────────────────────

const PREFIX_RE = /^\/p\/(pv_[A-Za-z0-9_-]+)(\/.*)?$/;

function parseCookie(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(new RegExp(`(?:^|;\\s*)${COOKIE}=(pv_[A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
}

/** For an UNPREFIXED request: which preview does it belong to? Referer path → cookie → the only active preview. */
function resolveUnprefixed(req: http.IncomingMessage): PreviewEntry | null {
  const ref = req.headers.referer;
  if (typeof ref === 'string') {
    const m = ref.match(/\/p\/(pv_[A-Za-z0-9_-]+)\//);
    if (m) {
      const e = getById(m[1]);
      if (e) return e;
    }
  }
  const fromCookie = parseCookie(req.headers.cookie);
  if (fromCookie) {
    const e = getById(fromCookie);
    if (e) return e;
  }
  return soleEntry();
}

// ── static serving ───────────────────────────────────────────────────────────

function safeResolve(root: string, rest: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segs = decoded.split('/').filter(Boolean);
  // Dotfiles/dot-dirs are refused anywhere in the path: .env, .git/config and
  // friends must not be one guessed URL away, even inside an allowed root.
  if (segs.some((s) => s === '..' || s.startsWith('.'))) return null;
  return path.join(root, ...segs);
}

function serveStatic(entry: PreviewEntry, rest: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const root = entry.target;
  let filePath = safeResolve(root, rest);
  if (!filePath) return notFound(res);

  let st = statOrNull(filePath);
  if (st?.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    st = statOrNull(filePath);
  }
  if (!st?.isFile() && entry.spa) {
    filePath = path.join(root, 'index.html');
    st = statOrNull(filePath);
  }
  if (!st?.isFile()) return notFound(res);

  // realpath containment AFTER resolution: a symlink inside the root pointing
  // at /etc resolves outside and is refused (same guard as file-manager's
  // resolveUnder / upload's safeJoin on the dashboard side).
  let real: string;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    return notFound(res);
  }
  if (real !== root && !real.startsWith(root + path.sep)) return notFound(res);

  const mime = mimeFor(real);
  const isHtml = mime.startsWith('text/html');
  const etag = `W/"${st.mtimeMs}-${st.size}"`;
  if (!isHtml && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    return res.end();
  }

  const baseHeaders: Record<string, string> = isHtml
    ? {
        'content-type': mime,
        'cache-control': 'no-store',
        // Affinity cookie for the unprefixed-request fallback. Not sensitive —
        // it only picks which preview an absolute-path asset request means.
        'set-cookie': `${COOKIE}=${entry.previewId}; Path=/; SameSite=Lax; Max-Age=86400`,
      }
    : { 'content-type': mime, 'cache-control': 'no-cache', etag };

  if (isHtml && entry.reload && st.size <= MAX_INJECT_BYTES) {
    fs.readFile(real, 'utf8', (err, html) => {
      if (err) return notFound(res);
      const out = Buffer.from(injectIntoHtml(html, entry.previewId));
      res.writeHead(200, { ...baseHeaders, 'content-length': String(out.byteLength) });
      res.end(out);
    });
    return;
  }

  res.writeHead(200, { ...baseHeaders, 'content-length': String(st.size) });
  const stream = fs.createReadStream(real);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// ── proxying ─────────────────────────────────────────────────────────────────

function targetParts(entry: PreviewEntry): { host: string; port: number; basePath: string } {
  const u = new URL(entry.target);
  return { host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port), basePath: u.pathname.replace(/\/$/, '') };
}

/** Directives like frame-ancestors would stop the dashboard embedding the preview; strip only that. */
function stripAntiEmbed(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === 'x-frame-options') continue;
    if (key === 'content-security-policy' || key === 'content-security-policy-report-only') {
      const filtered = (Array.isArray(v) ? v : [v])
        .map((h) => h.split(';').filter((d) => !/^\s*frame-ancestors/i.test(d)).join(';'))
        .filter((h) => h.trim().length > 0);
      if (filtered.length) out[k] = filtered.length === 1 ? filtered[0] : filtered;
      continue;
    }
    out[k] = v as string | string[];
  }
  return out;
}

function serveProxy(entry: PreviewEntry, rest: string, search: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const { host, port, basePath } = targetParts(entry);
  const forwardPath = `${basePath}/${rest}`.replace(/\/{2,}/g, '/') + search;

  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers.host = `${host}:${port}`;
  // identity so injected HTML never has to fight gzip; local loopback traffic,
  // compression buys nothing anyway.
  headers['accept-encoding'] = 'identity';
  delete headers.connection;

  const upstream = http.request({ host, port, method: req.method, path: forwardPath, headers }, (ur) => {
    const outHeaders = stripAntiEmbed(ur.headers);
    const ctype = String(ur.headers['content-type'] ?? '');
    const isHtml = ctype.includes('text/html');
    const wantInject = isHtml && entry.reload && entry.watchDir != null;
    const len = Number(ur.headers['content-length'] ?? NaN);

    if (isHtml) {
      outHeaders['set-cookie'] = appendSetCookie(outHeaders['set-cookie'], `${COOKIE}=${entry.previewId}; Path=/; SameSite=Lax; Max-Age=86400`);
    }

    if (wantInject && (Number.isNaN(len) || len <= MAX_INJECT_BYTES)) {
      const chunks: Buffer[] = [];
      let size = 0;
      let bailed = false;
      ur.on('data', (c: Buffer) => {
        if (bailed) return;
        size += c.length;
        if (size > MAX_INJECT_BYTES) {
          // Too big after all — flush what we have and fall back to streaming.
          bailed = true;
          delete outHeaders['content-length'];
          res.writeHead(ur.statusCode ?? 200, outHeaders);
          for (const b of chunks) res.write(b);
          res.write(c);
          ur.pipe(res);
          return;
        }
        chunks.push(c);
      });
      ur.on('end', () => {
        if (bailed) return;
        const out = Buffer.from(injectIntoHtml(Buffer.concat(chunks).toString('utf8'), entry.previewId));
        outHeaders['content-length'] = String(out.byteLength);
        res.writeHead(ur.statusCode ?? 200, outHeaders);
        res.end(out);
      });
      ur.on('error', () => res.destroy());
      return;
    }

    res.writeHead(ur.statusCode ?? 200, outHeaders);
    ur.pipe(res);
  });

  upstream.on('error', () => {
    textResponse(
      res,
      502,
      '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>502</title>' +
        `<p style="font:14px system-ui;color:#666;padding:2em">目标服务 ${entry.target} 未响应 —— agent 可能正在重启它，本页每 2 秒自动重试。</p>`,
    );
  });
  req.pipe(upstream);
}

function appendSetCookie(existing: string | string[] | undefined, cookie: string): string | string[] {
  if (!existing) return cookie;
  return Array.isArray(existing) ? [...existing, cookie] : [existing, cookie];
}

// ── the server ───────────────────────────────────────────────────────────────

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const rawUrl = req.url ?? '/';
  const qIdx = rawUrl.indexOf('?');
  const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  const search = qIdx === -1 ? '' : rawUrl.slice(qIdx);

  if (pathname === '/' || pathname === '/healthz') {
    return textResponse(res, 200, 'hermit live preview server');
  }

  // Bare /p/<id> → /p/<id>/ so the document's relative URLs resolve inside the prefix.
  const bare = pathname.match(/^\/p\/(pv_[A-Za-z0-9_-]+)$/);
  if (bare) {
    res.writeHead(301, { location: `/p/${bare[1]}/${search}` });
    return res.end();
  }

  const m = pathname.match(PREFIX_RE);
  if (m) {
    const entry = getById(m[1]);
    if (!entry) return notFound(res);
    touch(entry);
    const rest = (m[2] ?? '/').replace(/^\//, '');

    if (rest === '__hermit__/sse') {
      return addSseClient(entry.previewId, entry.watchDir, res);
    }
    if (entry.mode === 'static') return serveStatic(entry, rest, req, res);
    return serveProxy(entry, rest, search, req, res);
  }

  // Unprefixed (an absolute-path asset from a dev server). 307 preserves the
  // method for the odd POST; canonicalizing instead of serving directly means
  // everything the browser loads next is already prefixed.
  const entry = resolveUnprefixed(req);
  if (entry) {
    res.writeHead(307, { location: `/p/${entry.previewId}${rawUrl}`, 'cache-control': 'no-store' });
    return res.end();
  }
  return notFound(res);
}

/** WebSocket (and any Upgrade) passthrough — raw TCP splice to the pinned loopback target. */
function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  const rawUrl = req.url ?? '/';
  const m = rawUrl.match(PREFIX_RE);
  let entry: PreviewEntry | null = null;
  let forwardUrl = rawUrl;
  if (m) {
    entry = getById(m[1]);
    forwardUrl = m[2] && m[2].length > 0 ? m[2] : '/';
  } else {
    // vite's HMR socket connects at the server root, unprefixed — same cascade
    // as unprefixed HTTP, minus Referer (browsers don't send one on WS).
    entry = resolveUnprefixed(req);
  }
  if (!entry || entry.mode !== 'proxy') {
    socket.destroy();
    return;
  }
  touch(entry);

  const { host, port, basePath } = targetParts(entry);
  const target = net.connect(port, host, () => {
    const pathWithBase = `${basePath}${forwardUrl}`.replace(/\/{2,}/g, '/') || '/';
    const lines = [`${req.method ?? 'GET'} ${pathWithBase} HTTP/1.1`];
    // rawHeaders preserves duplicates and casing; host is rewritten to the target.
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = k.toLowerCase() === 'host' ? `${host}:${port}` : req.rawHeaders[i + 1];
      lines.push(`${k}: ${v}`);
    }
    target.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
  const kill = () => {
    socket.destroy();
    target.destroy();
  };
  target.on('error', kill);
  socket.on('error', kill);
}

export function startPreviewServe(): void {
  const server = http.createServer(handleRequest);
  server.on('upgrade', handleUpgrade);
  server.on('error', (e) => console.error('[preview] serve error:', e.message));
  server.listen(PREVIEW_SERVE_PORT, '127.0.0.1', () => {
    console.log(`[preview] serve listening on 127.0.0.1:${PREVIEW_SERVE_PORT}`);
  });
}
