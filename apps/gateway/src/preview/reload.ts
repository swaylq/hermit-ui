// Auto-reload for live previews: a per-preview SSE hub plus a polling mtime
// scanner. No fs.watch — platform.ts's portability contract (tmux/ps/tail, no
// fs.watch) holds here too, and interval polling is the house pattern anyway.
// The scanner only runs while at least one SSE client is connected, so a
// preview nobody is looking at costs nothing.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
import { bridgeSnippet, nonceAttr } from './bridge';

const SCAN_INTERVAL_MS = 1_000;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_SCAN_DEPTH = 8;
/** Names never scanned: huge and irrelevant to "did my page change". */
const SKIP_DIRS = new Set(['node_modules', '.git']);

interface Hub {
  clients: Set<ServerResponse>;
  watchDir: string;
  timer: NodeJS.Timeout | null;
  scanning: boolean;
  lastSig: string | null;
  /** Scan hit MAX_SCAN_ENTRIES — auto-reload off, clients were told once. */
  disabled: boolean;
}

const hubs = new Map<string, Hub>();

// ── scanning ─────────────────────────────────────────────────────────────────

async function scanDir(root: string): Promise<{ sig: string; truncated: boolean }> {
  const h = crypto.createHash('md5');
  let count = 0;
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated || depth > MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir vanished mid-scan — the next tick sees the new truth
    }
    for (const ent of entries) {
      if (truncated) return;
      const name = ent.name;
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile()) {
        if (++count > MAX_SCAN_ENTRIES) {
          truncated = true;
          return;
        }
        try {
          const st = await fs.promises.stat(full);
          h.update(`${full}:${st.mtimeMs}:${st.size}\n`);
        } catch {
          /* raced a delete */
        }
      }
    }
  }

  await walk(root, 0);
  return { sig: h.digest('hex') + `:${count}`, truncated };
}

function startScanner(previewId: string, hub: Hub) {
  if (hub.timer || hub.disabled) return;
  hub.timer = setInterval(() => {
    if (hub.scanning || hub.clients.size === 0) return;
    hub.scanning = true;
    scanDir(hub.watchDir)
      .then(({ sig, truncated }) => {
        if (truncated) {
          hub.disabled = true;
          stopScanner(hub);
          send(hub, 'watch-disabled'); // panel keeps working; refresh is manual
          console.log(`[preview] ${previewId}: >${MAX_SCAN_ENTRIES} files under ${hub.watchDir} — auto-reload off`);
          return;
        }
        if (hub.lastSig !== null && hub.lastSig !== sig) send(hub, 'reload');
        hub.lastSig = sig;
      })
      .catch(() => {})
      .finally(() => {
        hub.scanning = false;
      });
  }, SCAN_INTERVAL_MS);
}

function stopScanner(hub: Hub) {
  if (hub.timer) clearInterval(hub.timer);
  hub.timer = null;
  hub.lastSig = null; // a fresh first scan re-baselines instead of firing a stale diff
}

function send(hub: Hub, data: string) {
  for (const res of hub.clients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      /* dead socket — its close handler removes it */
    }
  }
}

// ── SSE plumbing ─────────────────────────────────────────────────────────────

/**
 * Attach an SSE client for a preview. `watchDir` null = no scanning (proxy mode
 * without --watch); the connection then only carries pings, and reloads never
 * fire — the upstream dev server's own HMR owns freshness.
 */
export function addSseClient(previewId: string, watchDir: string | null, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': hi\n\n');

  let hub = hubs.get(previewId);
  if (!hub) {
    hub = { clients: new Set(), watchDir: watchDir ?? '', timer: null, scanning: false, lastSig: null, disabled: false };
    hubs.set(previewId, hub);
  }
  hub.clients.add(res);
  if (watchDir) {
    hub.watchDir = watchDir;
    startScanner(previewId, hub);
  }

  // Same 15s cadence as the chat SSE stream — proven to keep Caddy/xray/rathole
  // from reaping the idle connection.
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* close handler cleans up */
    }
  }, 15_000);

  res.on('close', () => {
    clearInterval(ping);
    const h = hubs.get(previewId);
    if (!h) return;
    h.clients.delete(res);
    if (h.clients.size === 0) {
      stopScanner(h);
      hubs.delete(previewId); // nobody watching → zero standing cost
    }
  });
}

/** Tear down a preview's hub (registration removed): close every client so panels stop retrying. */
export function dropPreview(previewId: string): void {
  const hub = hubs.get(previewId);
  if (!hub) return;
  stopScanner(hub);
  for (const res of hub.clients) {
    try {
      res.end();
    } catch {
      /* already gone */
    }
  }
  hubs.delete(previewId);
}

// ── HTML injection ───────────────────────────────────────────────────────────

/** The auto-reload client, injected into served HTML. Inline — no extra route, auto-reconnects via EventSource. */
export function reloadSnippet(previewId: string, nonce?: string | null): string {
  return (
    `<script data-hermit-preview${nonceAttr(nonce)}>(function(){try{` +
    `var es=new EventSource("/p/${previewId}/__hermit__/sse");` +
    `es.onmessage=function(ev){if(ev.data==="reload"){es.close();location.reload();}};` +
    `}catch(e){}})();</script>`
  );
}

/**
 * What gets spliced into served HTML: always the panel bridge (back/forward,
 * reload, element picker — see bridge.ts), plus the auto-reload client when
 * something is actually being watched. A proxied dev server with its own HMR
 * has nothing to watch, but it still wants the bridge.
 */
export function previewSnippet(previewId: string, withReload: boolean, nonce?: string | null): string {
  return (withReload ? reloadSnippet(previewId, nonce) : '') + bridgeSnippet(nonce);
}

// ── where the snippet goes ───────────────────────────────────────────────────
//
// The end of <head> if there is one, else the end of <body>, else the end of the
// document. head first, because the bridge should be listening before the page's
// own scripts start moving history around.
//
// Finding it is a scan, not an indexOf, because `</head>` is ordinary text
// inside a <script>, a <style>, a <title> or a comment — splicing there drops a
// <script> tag into the middle of somebody's string literal and corrupts the
// page. So the scan tracks whether it is inside raw text, and skips it.
//
// Bytes, not a decoded string: a proxied chunk boundary can fall in the middle
// of a multi-byte character, and decoding half of one turns it into U+FFFD. The
// markup that matters here is pure ASCII, so bytes lose nothing.
//
// (Not handled, deliberately: `</head>` inside a <template>, and the script-data
// double-escaped state. Both leave the snippet somewhere harmless rather than
// somewhere wrong, and an HTML parser is not worth carrying for them.)

const b = (s: string) => Buffer.from(s, 'ascii');
const HEAD_CLOSE = b('</head>');
const BODY_CLOSE = b('</body>');
const COMMENT_OPEN = b('<!--');
const COMMENT_CLOSE = b('-->');
/** Elements whose content is text, not markup — anything tag-shaped inside is not a tag. */
const RAW_TEXT: Array<[Buffer, Buffer]> = [
  [b('<script'), b('</script')],
  [b('<style'), b('</style')],
  [b('<textarea'), b('</textarea')],
  [b('<title'), b('</title')],
];
/** The longest thing we match, so a caller streaming chunks knows how far back to re-read. */
export const SCAN_LOOKBACK = Math.max(...RAW_TEXT.flat().map((n) => n.length), HEAD_CLOSE.length, COMMENT_CLOSE.length);

/** ASCII-case-insensitive "does `needle` start at buf[i]", false if it would run off the end. */
function matchAt(buf: Buffer, i: number, needle: Buffer): boolean {
  if (i + needle.length > buf.length) return false;
  for (let j = 0; j < needle.length; j++) {
    let c = buf[i + j];
    if (c >= 0x41 && c <= 0x5a) c += 0x20;
    if (c !== needle[j]) return false;
  }
  return true;
}

/** A tag name ends at whitespace, `/` or `>` — so `<style>` opens one and `<styled-x>` does not. */
function endsTagName(c: number | undefined): boolean {
  return c === undefined || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x2f || c === 0x3e;
}

export interface ScanState {
  /** null = ordinary markup; otherwise the terminator we are looking for. */
  until: Buffer | null;
}

export const freshScan = (): ScanState => ({ until: null });

/**
 * Scan `buf[from..limit)` for the insertion point, carrying `state` across calls.
 * Returns -1 when there is none in range — the caller reads more, or gives up.
 * `limit` must leave SCAN_LOOKBACK bytes of slack unless the input is complete,
 * or a marker straddling the end is missed and the state goes wrong.
 */
export function scanForInsertPoint(buf: Buffer, from: number, limit: number, state: ScanState): number {
  let i = Math.max(0, from);
  const end = Math.min(limit, buf.length);
  while (i < end) {
    if (state.until) {
      if (matchAt(buf, i, state.until)) {
        i += state.until.length;
        state.until = null;
        continue;
      }
      i += 1;
      continue;
    }
    if (buf[i] !== 0x3c /* < */) {
      i += 1;
      continue;
    }
    if (matchAt(buf, i, COMMENT_OPEN)) {
      state.until = COMMENT_CLOSE;
      i += COMMENT_OPEN.length;
      continue;
    }
    if (matchAt(buf, i, HEAD_CLOSE) || matchAt(buf, i, BODY_CLOSE)) return i;
    let opened = false;
    for (const [open, close] of RAW_TEXT) {
      if (matchAt(buf, i, open) && endsTagName(buf[i + open.length])) {
        state.until = close;
        i += open.length;
        opened = true;
        break;
      }
    }
    if (!opened) i += 1;
  }
  return -1;
}

/** The whole-document form, for HTML read off disk. */
export function findInsertPoint(html: string): number {
  const buf = Buffer.from(html, 'utf8');
  return scanForInsertPoint(buf, 0, buf.length, freshScan());
}

export function injectIntoHtml(html: string, previewId: string, withReload: boolean, nonce?: string | null): string {
  const snippet = previewSnippet(previewId, withReload, nonce);
  const at = findInsertPoint(html);
  if (at === -1) return html + snippet;
  const buf = Buffer.from(html, 'utf8');
  return buf.subarray(0, at).toString('utf8') + snippet + buf.subarray(at).toString('utf8');
}

/**
 * The same splice, for a response we are proxying rather than reading off disk.
 *
 * Buffering the whole document would be simpler, and was what the --watch path
 * did — but now that EVERY proxied preview is injected, a dev server that
 * streams its SSR would be held at a blank page until it finished. So: hold only
 * until the insertion point shows up (it lives in the first kilobyte of any real
 * document), splice there, and pipe the rest through untouched.
 *
 * Markup that never shows one: past SCAN_LIMIT we stop looking and stream on,
 * appending the snippet at the end instead.
 */
export function htmlInjector(previewId: string, withReload: boolean, nonce?: string | null): Transform {
  const snippet = Buffer.from(previewSnippet(previewId, withReload, nonce), 'utf8');
  const SCAN_LIMIT = 128 * 1024;
  const state = freshScan();
  let held: Buffer | null = Buffer.alloc(0);
  let scanned = 0;
  let placed = false;

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (held === null) return cb(null, chunk); // already spliced, or given up
      held = held.length ? Buffer.concat([held, chunk]) : chunk;
      // Stop short of the end: a marker split across this boundary must be read
      // again with the next chunk, and re-reading is only safe for bytes whose
      // state we have not already advanced past.
      const limit = Math.max(0, held.length - SCAN_LOOKBACK + 1);
      const at = scanForInsertPoint(held, scanned, limit, state);
      if (at !== -1) {
        const out = Buffer.concat([held.subarray(0, at), snippet, held.subarray(at)]);
        held = null;
        placed = true;
        return cb(null, out);
      }
      scanned = limit;
      if (held.length >= SCAN_LIMIT) {
        const out = held;
        held = null; // stream the rest raw; flush() appends the snippet
        return cb(null, out);
      }
      cb();
    },
    flush(cb) {
      if (placed) return cb();
      if (held === null) return cb(null, snippet);
      // The document is complete now, so the tail we were holding back is safe
      // to scan to the very end.
      const at = scanForInsertPoint(held, scanned, held.length, state);
      cb(null, at === -1 ? Buffer.concat([held, snippet]) : Buffer.concat([held.subarray(0, at), snippet, held.subarray(at)]));
    },
  });
}
