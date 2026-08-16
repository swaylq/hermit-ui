// Live-preview admin — the loopback-only registration API the `hermit-preview`
// CLI talks to. Deliberately a SEPARATE listener from serve.ts: rathole hands
// tunneled public traffic to a loopback port too, so "is this connection
// local?" cannot be answered by source address — it is answered by which port
// was tunneled. This one never is.
//
// The CLI stays keyless: the dashboard write (ChatSession.livePreview) happens
// here with the gateway's own ASST_KEY via api.ts, which also buys the pinned
// HTTP/1.1 dispatcher + circuit breaker for free.

import http from 'node:http';
import { PREVIEW_ADMIN_PORT, PREVIEW_PUBLIC_BASE } from '../config';
import { api } from '../api';
import {
  getBySession,
  register,
  removeBySession,
  validateProxyTarget,
  validateStaticRoot,
  type PreviewMode,
} from './registry';
import { dropPreview } from './reload';

const MAX_BODY = 64 * 1024;

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(buf.byteLength) });
  res.end(buf);
}

function publicUrl(previewId: string): string {
  return `${PREVIEW_PUBLIC_BASE.replace(/\/$/, '')}/p/${previewId}/`;
}

/** Push the registration (or its removal) into ChatSession.livePreview. Best-effort: the URL works either way. */
async function syncToDashboard(sessionId: string, livePreview: { url: string; mode: PreviewMode; target: string; updatedAt: string } | null): Promise<string | null> {
  try {
    await api.syncLivePreview(sessionId, livePreview);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[preview] dashboard sync failed:', msg);
    return `dashboard sync failed (${msg.slice(0, 120)}) — 预览可用，但会话里的预览按钮可能不出现`;
  }
}

async function handleRegister(body: Record<string, unknown>, res: http.ServerResponse) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const rawTarget = typeof body.target === 'string' ? body.target.trim() : '';
  if (!/^[a-z0-9]{16,40}$/i.test(sessionId)) return json(res, 400, { error: 'missing/invalid sessionId (HERMIT_SESSION_ID env)' });
  if (!rawTarget) return json(res, 400, { error: 'missing target (a directory, a port, or an http://127.0.0.1:PORT URL)' });

  const wantSpa = body.spa === true;
  const noReload = body.noReload === true;
  const rawWatch = typeof body.watch === 'string' && body.watch.trim() ? body.watch.trim() : null;

  let mode: PreviewMode;
  let target: string;
  let watchDir: string | null;
  let display: string;
  try {
    if (typeof body.mode === 'string' && body.mode === 'static') {
      target = validateStaticRoot(rawTarget);
      mode = 'static';
      watchDir = target;
      display = target;
    } else if (typeof body.mode === 'string' && body.mode === 'proxy') {
      target = validateProxyTarget(rawTarget);
      mode = 'proxy';
      watchDir = rawWatch ? validateStaticRoot(rawWatch) : null;
      display = target;
    } else {
      return json(res, 400, { error: "mode must be 'static' or 'proxy'" });
    }
  } catch (e) {
    return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }

  let entry;
  try {
    entry = register({ sessionId, mode, target, watchDir, spa: wantSpa && mode === 'static', reload: !noReload });
  } catch (e) {
    return json(res, 409, { error: e instanceof Error ? e.message : String(e) });
  }

  const url = publicUrl(entry.previewId);
  const updatedAt = new Date().toISOString();
  const warning = await syncToDashboard(sessionId, { url, mode, target: display, updatedAt });

  // A system line in the timeline: instant (SSE) proof to the human that the
  // preview exists, with the link — the FAB itself rides the 5s getSession poll.
  try {
    await api.postChatSystemMessage(
      sessionId,
      `🖥️ Live preview 已开启：${url}\n（${mode} · ${display}）会话窗口右下角出现预览按钮，点开即看；${
        mode === 'static' ? '文件改动后 ≤1s 自动刷新' : '依赖目标服务自身热更'
      }。`,
      `preview-on-${entry.previewId}`,
    );
  } catch {
    /* cosmetic */
  }

  return json(res, 200, { ok: true, previewId: entry.previewId, url, mode, target: display, warning });
}

async function handleOff(body: Record<string, unknown>, res: http.ServerResponse) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) return json(res, 400, { error: 'missing sessionId' });
  const removed = removeBySession(sessionId);
  if (removed) dropPreview(removed.previewId);
  const warning = await syncToDashboard(sessionId, null);
  return json(res, 200, { ok: true, removed: !!removed, warning });
}

function handleStatus(sessionId: string | null, res: http.ServerResponse) {
  if (!sessionId) return json(res, 400, { error: 'missing sessionId' });
  const e = getBySession(sessionId);
  if (!e) return json(res, 200, { ok: true, active: false });
  return json(res, 200, {
    ok: true,
    active: true,
    previewId: e.previewId,
    url: publicUrl(e.previewId),
    mode: e.mode,
    target: e.target,
    watch: e.watchDir,
    createdAt: new Date(e.createdAt).toISOString(),
  });
}

export function startPreviewAdmin(): void {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    (async () => {
      if (req.method === 'POST' && url.pathname === '/register') return handleRegister(await readJson(req), res);
      if (req.method === 'POST' && url.pathname === '/off') return handleOff(await readJson(req), res);
      if (req.method === 'GET' && url.pathname === '/status') return handleStatus(url.searchParams.get('sessionId'), res);
      return json(res, 404, { error: 'unknown endpoint — POST /register, POST /off, GET /status?sessionId=' });
    })().catch((e) => {
      try {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      } catch {
        /* socket gone */
      }
    });
  });
  server.on('error', (e) => console.error('[preview] admin error:', e.message));
  server.listen(PREVIEW_ADMIN_PORT, '127.0.0.1', () => {
    console.log(`[preview] admin listening on 127.0.0.1:${PREVIEW_ADMIN_PORT}`);
  });
}
