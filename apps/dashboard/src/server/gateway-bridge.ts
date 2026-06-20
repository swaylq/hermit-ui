// Shared singleton bridging the custom server's gateway WebSocket (server.ts) to
// the tRPC routers + route handlers of the Next app. They run in the SAME Node
// process but load through different module graphs (tsx for server.ts, Next's
// bundler for the app), so module-level state would NOT be shared between them.
// Everything therefore lives on globalThis — one instance per process, reachable
// from both sides.
//
//   gateways:  machineId → live gateway WS         (set by server.ts on connect)
//   pending:   reqId → resolver for an in-flight fs.req   (interactive file ops)
//   downloads: downloadId → prepared-download status (gateway streams bytes up to
//              /api/file-manager/ingest; the browser pulls them from the stash)

import type { WebSocket as WSWebSocket } from 'ws';

export type FsResponse = { ok: true; data: unknown } | { ok: false; error: string };

export interface DownloadEntry {
  machineId: string;
  status: 'preparing' | 'ready' | 'error';
  filename: string;
  size: number;
  error?: string;
  createdAt: number;
}

interface BridgeState {
  gateways: Map<string, WSWebSocket>;
  pending: Map<string, { resolve: (r: FsResponse) => void; timer: ReturnType<typeof setTimeout> }>;
  downloads: Map<string, DownloadEntry>;
  seq: number;
}

const KEY = '__hermitGatewayBridge';
function bridge(): BridgeState {
  const g = globalThis as unknown as Record<string, BridgeState | undefined>;
  if (!g[KEY]) g[KEY] = { gateways: new Map(), pending: new Map(), downloads: new Map(), seq: 0 };
  return g[KEY]!;
}

const WS_OPEN = 1;

export function setGatewaySocket(machineId: string, sock: WSWebSocket): void {
  bridge().gateways.set(machineId, sock);
}
export function clearGatewaySocket(machineId: string, sock: WSWebSocket): void {
  const b = bridge();
  if (b.gateways.get(machineId) === sock) b.gateways.delete(machineId);
}
export function gatewayOnline(machineId: string): boolean {
  const s = bridge().gateways.get(machineId) as { readyState?: number } | undefined;
  return !!s && s.readyState === WS_OPEN;
}

// Send an fs.req to a machine's gateway and await its fs.res. Always RESOLVES
// (never rejects) to a tagged result so callers branch on `.ok` without try/catch.
export function requestFs(
  machineId: string,
  op: string,
  args: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<FsResponse> {
  const b = bridge();
  const sock = b.gateways.get(machineId) as (WSWebSocket & { readyState: number }) | undefined;
  if (!sock || sock.readyState !== WS_OPEN) return Promise.resolve({ ok: false, error: 'gateway 离线' });
  b.seq = (b.seq + 1) % 1_000_000_000;
  const reqId = `fs_${b.seq.toString(36)}_${Date.now().toString(36)}`;
  return new Promise<FsResponse>((resolve) => {
    const timer = setTimeout(() => {
      b.pending.delete(reqId);
      resolve({ ok: false, error: 'gateway 超时' });
    }, timeoutMs);
    b.pending.set(reqId, { resolve, timer });
    try {
      sock.send(JSON.stringify({ type: 'fs.req', reqId, op, ...args }));
    } catch {
      clearTimeout(timer);
      b.pending.delete(reqId);
      resolve({ ok: false, error: 'gateway 发送失败' });
    }
  });
}

// Send a secrets.req to a machine's gateway and await its secrets.res. Same
// request/response plumbing as requestFs (shared pending map; server.ts routes
// secrets.res frames through resolveFsResponse too) — the gateway decrypts the
// store locally because the age master key lives in ITS Keychain, not the VPS.
export function requestSecrets(
  machineId: string,
  op: string,
  args: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<FsResponse> {
  const b = bridge();
  const sock = b.gateways.get(machineId) as (WSWebSocket & { readyState: number }) | undefined;
  if (!sock || sock.readyState !== WS_OPEN) return Promise.resolve({ ok: false, error: 'gateway 离线' });
  b.seq = (b.seq + 1) % 1_000_000_000;
  const reqId = `sec_${b.seq.toString(36)}_${Date.now().toString(36)}`;
  return new Promise<FsResponse>((resolve) => {
    const timer = setTimeout(() => {
      b.pending.delete(reqId);
      resolve({ ok: false, error: 'gateway 超时' });
    }, timeoutMs);
    b.pending.set(reqId, { resolve, timer });
    try {
      sock.send(JSON.stringify({ type: 'secrets.req', reqId, op, ...args }));
    } catch {
      clearTimeout(timer);
      b.pending.delete(reqId);
      resolve({ ok: false, error: 'gateway 发送失败' });
    }
  });
}

// Called by server.ts for every fs.res / secrets.res frame a gateway sends.
export function resolveFsResponse(msg: { reqId?: string; ok?: boolean; data?: unknown; error?: unknown }): void {
  const b = bridge();
  const reqId = typeof msg?.reqId === 'string' ? msg.reqId : '';
  const p = b.pending.get(reqId);
  if (!p) return;
  b.pending.delete(reqId);
  clearTimeout(p.timer);
  p.resolve(msg.ok ? { ok: true, data: msg.data } : { ok: false, error: String(msg.error ?? '未知错误') });
}

// ── prepared-download bookkeeping ───────────────────────────────────────────
export function createDownload(id: string, machineId: string): void {
  const b = bridge();
  b.downloads.set(id, { machineId, status: 'preparing', filename: '', size: 0, createdAt: Date.now() });
  // GC entries older than 30 min so the map can't grow unbounded.
  const cutoff = Date.now() - 30 * 60_000;
  for (const [k, v] of [...b.downloads.entries()]) if (v.createdAt < cutoff) b.downloads.delete(k);
}
export function getDownload(id: string): DownloadEntry | undefined {
  return bridge().downloads.get(id);
}
export function markDownloadReady(id: string, filename: string, size: number): void {
  const e = bridge().downloads.get(id);
  if (e) {
    e.status = 'ready';
    e.filename = filename;
    e.size = size;
  }
}
export function markDownloadError(id: string, error: string): void {
  const e = bridge().downloads.get(id);
  if (e) {
    e.status = 'error';
    e.error = error;
  }
}
export function deleteDownload(id: string): void {
  bridge().downloads.delete(id);
}
