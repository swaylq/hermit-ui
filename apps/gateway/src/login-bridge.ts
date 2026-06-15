// Localhost WS bridge between the gateway and the Chrome login extension.
//
// Cloudflare flags Playwright-launched Chrome no matter how we patch it (fresh,
// untrusted profile + automation tells). The fix is to drive the user's REAL
// Chrome via an MV3 extension: real profile, real trust history, no webdriver, no
// CDP. The extension (running in Chrome on THIS Mac) connects here over loopback;
// the orchestrator sends DOM commands and awaits results.
//
// Security: bound to 127.0.0.1 only (no remote reach) + a token handshake so a
// random local process can't drive the user's browser. Token lives in
// ~/.hermit/login-bridge.json (0600); the user pastes it into the extension once.

import { WebSocketServer, WebSocket } from 'ws';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.LOGIN_BRIDGE_PORT || 47615);
const TOKEN_FILE = path.join(os.homedir(), '.hermit', 'login-bridge.json');
const CMD_TIMEOUT_MS = 30_000;

let ext: WebSocket | null = null; // the one connected extension (last wins)
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

// Extension-initiated login: the popup can paste an account string and trigger
// the flow right here (no dashboard round-trip; the `sk` is dropped in the popup).
// The gateway registers a handler; progress streams back to the popup.
export type ExtLoginCreds = { email: string; mailToken: string; emailPassword?: string };
export type ExtLoginReport = (u: { status?: string; line?: string }) => void;
let loginHandler: ((creds: ExtLoginCreds, report: ExtLoginReport) => Promise<void>) | null = null;
export function onExtensionLogin(h: (creds: ExtLoginCreds, report: ExtLoginReport) => Promise<void>): void {
  loginHandler = h;
}
function sendToExtension(obj: unknown): void {
  if (ext?.readyState === WebSocket.OPEN) {
    try {
      ext.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }
}

function ensureToken(): { port: number; token: string } {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (j?.token) return { port: PORT, token: String(j.token) };
  } catch {
    /* generate below */
  }
  const token = randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ port: PORT, token }, null, 2), { mode: 0o600 });
  return { port: PORT, token };
}

export function isExtensionConnected(): boolean {
  return ext?.readyState === WebSocket.OPEN;
}

// Send one DOM command to the extension and await its result. Rejects if no
// extension is connected or the command times out.
export function sendCommand<T = any>(op: string, args?: unknown, timeoutMs = CMD_TIMEOUT_MS): Promise<T> {
  if (!isExtensionConnected()) return Promise.reject(new Error('Chrome 扩展未连接'));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`扩展命令超时：${op}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      ext!.send(JSON.stringify({ id, op, args }));
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export function startLoginBridge(): void {
  const { port, token } = ensureToken();
  let wss: WebSocketServer;
  try {
    wss = new WebSocketServer({ host: '127.0.0.1', port });
  } catch (e) {
    console.error('[login-bridge] failed to start:', e instanceof Error ? e.message : e);
    return;
  }
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('token') !== token) {
      console.log('[login-bridge] rejected connection — bad token');
      ws.close(4001, 'bad token');
      return;
    }
    // One driver at a time — a new connection supersedes the old.
    if (ext && ext !== ws) {
      try {
        ext.close();
      } catch {
        /* ignore */
      }
    }
    ext = ws;
    console.log('[login-bridge] extension connected');
    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      // Extension-initiated login (paste-in-popup).
      if (msg?.kind === 'login') {
        const report: ExtLoginReport = (u) => sendToExtension({ kind: 'progress', status: u.status, line: u.line });
        if (!loginHandler) {
          report({ status: 'error', line: '网关未就绪（loginHandler 未注册）' });
          return;
        }
        const creds: ExtLoginCreds = {
          email: String(msg.email || ''),
          mailToken: String(msg.mailToken || ''),
          emailPassword: msg.emailPassword ? String(msg.emailPassword) : undefined,
        };
        loginHandler(creds, report).catch((e) => report({ status: 'error', line: String(e?.message || e) }));
        return;
      }
      // Otherwise: a reply to a command we sent.
      const p = pending.get(msg?.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(String(msg.error || 'extension error')));
    });
    ws.on('close', () => {
      if (ext === ws) ext = null;
      console.log('[login-bridge] extension disconnected');
    });
    ws.on('error', () => {
      if (ext === ws) ext = null;
    });
  });
  wss.on('error', (e) => console.error('[login-bridge] server error:', e));
  console.log(`[login-bridge] listening ws://127.0.0.1:${port} (token in ${TOKEN_FILE})`);
}
