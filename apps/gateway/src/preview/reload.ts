// Auto-reload for live previews: a per-preview SSE hub plus a polling mtime
// scanner. No fs.watch — platform.ts's portability contract (tmux/ps/tail, no
// fs.watch) holds here too, and interval polling is the house pattern anyway.
// The scanner only runs while at least one SSE client is connected, so a
// preview nobody is looking at costs nothing.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';

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

/** The auto-reload client, injected before </body> of served HTML. Inline — no extra route, auto-reconnects via EventSource. */
export function reloadSnippet(previewId: string): string {
  return (
    `<script data-hermit-preview>(function(){try{` +
    `var es=new EventSource("/p/${previewId}/__hermit__/sse");` +
    `es.onmessage=function(ev){if(ev.data==="reload"){es.close();location.reload();}};` +
    `}catch(e){}})();</script>`
  );
}

export function injectIntoHtml(html: string, previewId: string): string {
  const snippet = reloadSnippet(previewId);
  const i = html.toLowerCase().lastIndexOf('</body>');
  if (i === -1) return html + snippet;
  return html.slice(0, i) + snippet + html.slice(i);
}
