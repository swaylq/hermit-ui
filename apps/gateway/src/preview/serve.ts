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

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { PREVIEW_SERVE_PORT } from '../config';
import { getById, soleEntry, touch, type PreviewEntry } from './registry';
import { addSseClient, htmlInjector, injectIntoHtml } from './reload';

/** A static file bigger than this is served raw rather than read into memory to be injected. */
const MAX_INJECT_BYTES = 2 * 1024 * 1024;
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

/**
 * The status pages a user can meet inside the dashboard's preview iframe (404,
 * dead upstream, server root). Styled to read as part of hermit: pure-neutral
 * palette in both themes, a size-6px status dot + tracked uppercase label, mono
 * body text, zero shadow. Self-contained (~1KB), no scripts.
 */
function statusPage(opts: {
  title: string;
  label: string;
  message: string;
  dot: 'muted' | 'amber';
  /** meta-refresh seconds (the 502 page auto-retries). */
  refresh?: number;
}): string {
  const refresh = opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : '';
  const dot =
    opts.dot === 'amber'
      ? 'background:#d97706;animation:breathe 1.4s ease-in-out infinite'
      : 'background:var(--muted)';
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `${refresh}<title>${opts.title}</title><style>` +
    `:root{--bg:#ffffff;--fg:#252525;--muted:#8f8f8f;--line:rgba(0,0,0,.08)}` +
    `@media(prefers-color-scheme:dark){:root{--bg:#141414;--fg:#fafafa;--muted:#7d7d7d;--line:rgba(255,255,255,.1)}}` +
    `*{box-sizing:border-box}html,body{height:100%}` +
    `body{margin:0;display:grid;place-items:center;background:var(--bg);color:var(--fg);` +
    `font:13px/1.6 -apple-system,"SF Pro Text",system-ui,"PingFang SC",sans-serif}` +
    `main{display:flex;flex-direction:column;align-items:center;gap:10px;padding:32px;text-align:center}` +
    `.row{display:flex;align-items:center;gap:8px}` +
    `.dot{width:6px;height:6px;border-radius:999px;${dot}}` +
    `.label{font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}` +
    `.msg{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12px;color:var(--muted);max-width:36em}` +
    `@keyframes breathe{0%,100%{opacity:.25;transform:scale(.7)}50%{opacity:1;transform:scale(1)}}` +
    `@media(prefers-reduced-motion:reduce){.dot{animation:none}}` +
    `</style></head><body><main>` +
    `<div class="row"><span class="dot"></span><span class="label">${opts.label}</span></div>` +
    `<p class="msg">${opts.message}</p>` +
    `</main></body></html>`
  );
}

function notFound(res: http.ServerResponse) {
  textResponse(
    res,
    404,
    statusPage({
      title: '404 · hermit live preview',
      label: 'preview not found',
      message: '预览不存在或已过期 —— 让 agent 重新执行 hermit-preview 即可换新链接。',
      dot: 'muted',
    }),
  );
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
      const out = Buffer.from(injectIntoHtml(html, entry.previewId, entry.watchDir != null));
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

/**
 * Rewrite the upstream's response headers for life inside the dashboard's frame.
 *
 * Two edits, both to policies the app set for a context it is no longer in:
 * frame-ancestors (and X-Frame-Options) would refuse the embedding outright, and
 * a script-src without 'unsafe-inline' — helmet's default — would refuse the
 * snippet we are about to splice in, leaving the panel's controls dead with no
 * clue why. `nonce` is that snippet's, and is allowed through rather than the
 * directive being dropped: the app's own protection stays exactly as strict.
 */
export function stripAntiEmbed(headers: http.IncomingHttpHeaders, nonce?: string | null): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === 'x-frame-options') continue;
    if (key === 'content-security-policy' || key === 'content-security-policy-report-only') {
      const filtered = (Array.isArray(v) ? v : [v])
        .map((h) => rewriteCsp(h, nonce))
        .filter((h) => h.trim().length > 0);
      if (filtered.length) out[k] = filtered.length === 1 ? filtered[0] : filtered;
      continue;
    }
    out[k] = v as string | string[];
  }
  return out;
}

/** Drop frame-ancestors; let our nonce through whichever directive governs scripts. */
function rewriteCsp(policy: string, nonce?: string | null): string {
  const kept = policy.split(';').filter((d) => !/^\s*frame-ancestors/i.test(d));
  if (nonce) {
    // script-src if it exists, else default-src, which script-src falls back to.
    // Neither present means scripts are unrestricted and there is nothing to do.
    let i = kept.findIndex((d) => /^\s*script-src\s/i.test(d));
    if (i === -1) i = kept.findIndex((d) => /^\s*default-src\s/i.test(d));
    if (i !== -1) kept[i] = `${kept[i].trimEnd()} 'nonce-${nonce}'`;
  }
  return kept.join(';');
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
    const ctype = String(ur.headers['content-type'] ?? '');
    const isHtml = ctype.includes('text/html');
    // Injected even without --watch: a dev server owns its own freshness, but
    // the panel's back/forward/picker bridge has to come from somewhere, and
    // the reload half is left out below when there is nothing to watch.
    //
    // Three responses are left alone. A HEAD, a 204 or a 304 has no body to
    // splice into (and a body on a 304 is a protocol error, not a preview). A
    // compressed one we asked not to be compressed is a server that ignores
    // accept-encoding — splicing text into a gzip stream would break the page
    // outright, so it keeps its bytes and loses the controls.
    const encoding = String(ur.headers['content-encoding'] ?? '').trim().toLowerCase();
    const hasBody = req.method !== 'HEAD' && ur.statusCode !== 204 && ur.statusCode !== 304;
    const plain = encoding === '' || encoding === 'identity';
    const wantInject = isHtml && entry.reload && hasBody && plain;

    const nonce = wantInject ? crypto.randomBytes(16).toString('base64') : null;
    const outHeaders = stripAntiEmbed(ur.headers, nonce);

    if (isHtml) {
      outHeaders['set-cookie'] = appendSetCookie(outHeaders['set-cookie'], `${COOKIE}=${entry.previewId}; Path=/; SameSite=Lax; Max-Age=86400`);
    }

    if (wantInject) {
      // The body grows by the snippet and we are not going to count it, so the
      // upstream's framing headers go and Node re-frames the response itself.
      // Streaming (htmlInjector) rather than buffering, so a dev server that
      // streams its SSR is not held at a blank page until it finishes.
      delete outHeaders['content-length'];
      delete outHeaders['transfer-encoding'];
      res.writeHead(ur.statusCode ?? 200, outHeaders);
      const inject = htmlInjector(entry.previewId, entry.watchDir != null, nonce);
      ur.on('error', () => res.destroy());
      inject.on('error', () => res.destroy());
      ur.pipe(inject).pipe(res);
      return;
    }

    res.writeHead(ur.statusCode ?? 200, outHeaders);
    ur.pipe(res);
  });

  upstream.on('error', () => {
    textResponse(
      res,
      502,
      statusPage({
        title: '502 · hermit live preview',
        label: 'waiting for service',
        message: `${entry.target} 未响应 —— agent 可能正在重启它，本页每 2 秒自动重试。`,
        dot: 'amber',
        refresh: 2,
      }),
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

  // /healthz stays machine-plain (curl/grep probes); the root gets the styled
  // page a human sees when they open the bare domain.
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('hermit live preview server');
  }
  if (pathname === '/') {
    return textResponse(
      res,
      200,
      statusPage({
        title: 'hermit live preview',
        label: 'hermit live preview server',
        message: '在会话里执行 hermit-preview <目录|端口> 即可把页面挂到这里。',
        dot: 'muted',
      }),
    );
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
