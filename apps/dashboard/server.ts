// Custom Next.js server. Wraps `next start` so we can attach WebSocket
// upgrade handlers on the same port (4101) that already serves HTTP routes.
//
// Two WS endpoints:
//
//   /api/gateway/ws       — persistent inbound from each Mac gateway. One slot
//                            per machineId (multiple hosts coexist; each Mac
//                            opens its own and only routes for its own
//                            ChatSessions). Auth: x-asst-key request header,
//                            validated via bcrypt.compare against Machine.keyHash.
//                            The old ?key= form remains a rolling-upgrade fallback.
//
//   /api/asr/<sessionId>  — realtime voice input. The browser streams 16 kHz mono
//                            PCM16 up as binary frames and gets partial / final /
//                            polished transcript JSON back down; the DashScope
//                            streaming-ASR task on the far side lives in
//                            src/server/asr-stream.ts. Same subprotocol auth as
//                            the terminal below, and — like it — MACHINE KEY
//                            ONLY: a scoped agent-share token gets 401 and the
//                            browser stays on the batch /api/transcribe path.
//
//   /api/term/<sessionId> — per-tab from the browser running xterm.js. Auth:
//                            Sec-WebSocket-Protocol subprotocol `hermit-key.<token>`
//                            (keeping the key out of URL access logs).
//                            Authorizes the key, then checks the session
//                            belongs to that machine. Bridges frames into the
//                            singleton gateway control channel using a
//                            session-scoped `termId`.
//
// Why on the same port: keeps the deploy footprint identical (one pm2 process,
// one Caddy reverse_proxy directive, no extra firewall holes). Caddy proxies
// WS through reverse_proxy automatically; only thing we'd add is a longer
// idle timeout if needed (heartbeats below handle that).
//
// What this server is NOT: it does NOT bypass any Next.js routing. All
// non-WS HTTP still goes through `handle(req, res)` — same behavior as
// `next start`. Custom server caveats (Automatic Static Optimization etc.)
// apply but we already had a fully dynamic app (per-request auth + DB).

import { createServer } from 'node:http';
import { parse as parseUrl } from 'node:url';
import next from 'next';
import type { IncomingMessage } from 'node:http';
import type { RawData } from 'ws';
import { WebSocketServer, type WebSocket as WSWebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import { PrismaClient } from './src/generated/prisma/client';
import { setGatewaySocket, clearGatewaySocket, resolveFsResponse } from './src/server/gateway-bridge';
import { createAsrWsServer } from './src/server/asr-ws';
import { loadContext } from './src/server/transcribe-context';
import { tmuxPaneName } from './src/lib/pane-name';
import { gatewayUpgradeKey } from './src/server/gateway-ws-auth';

const port = parseInt(process.env.PORT || '4101', 10);
const dev = process.env.NODE_ENV !== 'production';

// Single Prisma client for this server — auth-only, no schema access from
// here beyond Machine + ChatSession lookups for the WS upgrade. The Next.js
// app-router routes get their own client via @/server/db (this is a
// different module instance, but Prisma is fine with that — they share the
// connection pool when DATABASE_URL is the same).
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// Cache resolved keys for 5 min — mirrors apps/dashboard/src/server/trpc.ts.
// bcrypt.compare costs 50–200ms each, so without this every browser WS
// connect would spend a quarter-second on auth.
interface AuthHit { machineId: string; cachedAt: number }
const authCache = new Map<string, AuthHit>();
const AUTH_TTL_MS = 5 * 60_000;
const LAST_SEEN_BUMP_MS = 30_000;

async function resolveMachineByKey(key: string): Promise<string | null> {
  if (!key) return null;
  const hit = authCache.get(key);
  if (hit && Date.now() - hit.cachedAt < AUTH_TTL_MS) return hit.machineId;
  const prefix = key.slice(0, 8);
  const candidates = await prisma.machine.findMany({ where: { keyPrefix: prefix } });
  for (const m of candidates) {
    if (await bcrypt.compare(key, m.keyHash)) {
      authCache.set(key, { machineId: m.id, cachedAt: Date.now() });
      return m.id;
    }
  }
  return null;
}

// ── Per-machine gateway control connections ─────────────────────────────────
//
// One Mac gateway per machineId. Multiple Macs (multi-host hermit-agent) each
// open their own outbound /api/gateway/ws keyed by their ASST_KEY — we resolve
// that to a machineId at upgrade time and route per-session frames to the
// gateway whose machine owns the ChatSession.
//
// If a second gateway connects with the same machineId (e.g. the Mac restarted
// before TCP RST landed), the older socket is superseded — close it cleanly
// and prefer the newer.

const gateways = new Map<string, WSWebSocket>();          // machineId → socket
// termId → { browser, machineId } — machineId so we know which gateway owns
// the pty (need it both for routing input frames and for scoped cleanup when a
// single gateway disconnects without dragging other machines' terms down).
const termRoutes = new Map<string, { browser: WSWebSocket; machineId: string }>();
// browserSocket → set of termIds it owns (so browser disconnect cleans up).
const browserTerms = new WeakMap<WSWebSocket, Set<string>>();

function sendGatewayFor(machineId: string, payload: unknown): boolean {
  const sock = gateways.get(machineId);
  if (!sock || sock.readyState !== sock.OPEN) return false;
  try {
    sock.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function sendBrowser(sock: WSWebSocket, payload: unknown) {
  if (sock.readyState !== sock.OPEN) return;
  try {
    sock.send(JSON.stringify(payload));
  } catch {
    // socket vanished mid-send — close+cleanup handler will run
  }
}

const TERM_PATH_RE = /^\/api\/term\/([^\/?#]+)$/;
const GATEWAY_PATH = '/api/gateway/ws';

// ── Cross-origin API access ──────────────────────────────────────────
// One installed PWA is bound to ONE origin, but the browser keyring can hold
// entries pointing at other deployments (KeyringEntry.baseUrl), so a tab served
// by dash.swaylab.ai may call THIS server's API. That works because the
// credential is the `x-asst-key` request header rather than a cookie — but a
// custom header makes every request non-simple, so the browser sends an OPTIONS
// preflight first and refuses the real request unless we answer it.
//
// Empty allowlist (the default) = no cross-origin access at all. Set
// CORS_ALLOW_ORIGINS to a comma-separated list of origins that may drive this
// deployment, e.g. CORS_ALLOW_ORIGINS=https://dash.swaylab.ai
// Credentials are never allowed: there is no cookie or session to protect, and
// leaving them off means a hostile page still cannot ride an existing login.
//
// The allowlist is read on the FIRST REQUEST, not at module load: `.env` is
// merged into process.env by Next inside app.prepare(), which runs after this
// module is evaluated, so a module-level const would always see an empty list
// on a deployment that configures itself through .env.
let corsOrigins: Set<string> | null = null;
function corsAllowlist(): Set<string> {
  if (!corsOrigins) {
    corsOrigins = new Set(
      (process.env.CORS_ALLOW_ORIGINS || '')
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    );
  }
  return corsOrigins;
}
const CORS_PATH_RE = /^\/(api|uploads)\//;
const CORS_FALLBACK_HEADERS = 'content-type, x-asst-key, x-file-name, x-file-path, x-file-unzip';

/**
 * Add CORS headers when this is a cross-origin call from an allowlisted origin.
 * Returns true when the request was fully answered (a preflight), in which case
 * the caller must NOT pass it to Next — Next would 405 an OPTIONS on a route
 * that only exports GET/POST.
 */
function applyCors(req: IncomingMessage, res: import('node:http').ServerResponse): boolean {
  const origin = req.headers.origin;
  const path = (req.url || '/').split('?')[0];
  if (!origin || !CORS_PATH_RE.test(path)) return false;
  // Vary regardless of the outcome: the response for one Origin must never be
  // served from a shared cache to another.
  res.setHeader('Vary', 'Origin');
  if (!corsAllowlist().has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    // Echo what was asked for — the allowlist above is the real boundary, and
    // echoing means a new client header never turns into a silent CORS failure.
    res.setHeader(
      'Access-Control-Allow-Headers',
      (req.headers['access-control-request-headers'] as string) || CORS_FALLBACK_HEADERS,
    );
    res.setHeader('Access-Control-Max-Age', '86400');
    res.writeHead(204).end();
    return true;
  }
  return false;
}

const app = next({ dev, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    // Preflights are answered here and go no further; everything else picks up
    // the Allow-Origin header on the way out.
    if (applyCors(req, res)) return;
    // Defer everything to Next — including 404s on /api/* routes that don't
    // exist. WS upgrade is handled separately on the 'upgrade' event.
    handle(req, res, parseUrl(req.url || '/', true));
  });

  // ── Gateway WS server ────────────────────────────────────────────────────
  const gatewayWss = new WebSocketServer({ noServer: true });
  gatewayWss.on('connection', (sock: WSWebSocket, req: IncomingMessage, ctx: { machineId: string }) => {
    const { machineId } = ctx;
    let lastSeenBumpedAt = 0;
    const bumpLastSeen = () => {
      const now = Date.now();
      if (now - lastSeenBumpedAt < LAST_SEEN_BUMP_MS) return;
      lastSeenBumpedAt = now;
      void prisma.machine
        .update({ where: { id: machineId }, data: { lastSeen: new Date(now) } })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[gateway-ws] lastSeen update failed machineId=${machineId.slice(-6)}: ${message}`);
        });
    };
    // Auth already happened during upgrade — we only get here on success.
    // Supersede any prior connection from the SAME machineId; other machines'
    // gateways stay routed normally.
    const prior = gateways.get(machineId);
    if (prior && prior !== sock) {
      try { prior.close(1000, 'superseded'); } catch {}
    }
    gateways.set(machineId, sock);
    // Mirror into the cross-module bridge so tRPC / route handlers can send the
    // file-manager fs.req frames over this same socket (see gateway-bridge.ts).
    setGatewaySocket(machineId, sock);
    console.log(`[gateway-ws] connected machineId=${machineId.slice(-6)} from ${req.socket.remoteAddress}`);
    bumpLastSeen();

    // Heartbeat — Caddy/Xray idle proxies drop quiet conns after ~1m.
    const heartbeat = setInterval(() => {
      if (sock.readyState !== sock.OPEN) return;
      try { sock.ping(); } catch {}
    }, 15_000);

    sock.on('message', (raw: RawData) => {
      bumpLastSeen();
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      // File-manager + secrets responses (reqId-correlated, no termId) — both use
      // the same pending map in the bridge, so resolve them the same way.
      if (msg.type === 'fs.res' || msg.type === 'secrets.res') {
        resolveFsResponse(msg);
        return;
      }
      const termId = typeof msg.termId === 'string' ? msg.termId : '';
      if (!termId) return;
      const route = termRoutes.get(termId);
      if (!route) return;
      // Cross-machine safety: a gateway must only feed frames for ptys it owns.
      // A misbehaving (or just lagging post-supersede) gateway can't poison
      // another machine's term.
      if (route.machineId !== machineId) return;
      if (msg.type === 'pty.data' || msg.type === 'pty.exit') {
        sendBrowser(route.browser, msg);
        if (msg.type === 'pty.exit') {
          // Pty done — clean up our route mapping but leave the browser
          // socket open so the UI can show "[disconnected]" and let the
          // user trigger a reconnect.
          termRoutes.delete(termId);
        }
      }
    });

    // `ws` automatically answers protocol pings. Bump only when traffic proves
    // the authenticated peer is alive; merely writing our own ping could keep a
    // half-dead TCP connection falsely online. The 30s debounce stays well
    // inside the UI's 90s online window without writing on every 15s heartbeat.
    sock.on('ping', bumpLastSeen);
    sock.on('pong', bumpLastSeen);

    sock.on('close', () => {
      clearInterval(heartbeat);
      // Only drop the slot if WE are still the current gateway for this
      // machine — a supersede already swapped us out otherwise.
      if (gateways.get(machineId) === sock) {
        gateways.delete(machineId);
      }
      clearGatewaySocket(machineId, sock);
      console.log(`[gateway-ws] disconnected machineId=${machineId.slice(-6)}`);
      // Kill terms tied to THIS machine only. Other machines' terms keep going.
      for (const [termId, route] of [...termRoutes.entries()]) {
        if (route.machineId !== machineId) continue;
        sendBrowser(route.browser, { type: 'pty.exit', termId, code: -1, reason: 'gateway-offline' });
        termRoutes.delete(termId);
      }
    });

    sock.on('error', (err: Error) => {
      console.error(`[gateway-ws] error machineId=${machineId.slice(-6)}:`, err.message);
    });
  });

  // ── Browser terminal WS server ───────────────────────────────────────────
  // handleProtocols: echo the first hermit-key.* subprotocol the browser
  // offered. Browsers reject the 101 if no acceptable subprotocol comes back
  // (they sent at least one), so this is non-optional for our key-in-subproto
  // scheme.
  const termWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      for (const p of protocols) {
        if (typeof p === 'string' && p.startsWith('hermit-key.')) return p;
      }
      return false;
    },
  });
  termWss.on('connection', (sock: WSWebSocket, req: IncomingMessage, ctx: { sessionId: string; paneName: string; machineId: string }) => {
    const termId = `t_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    const { machineId } = ctx;
    console.log(`[term-ws] connected sid=${ctx.sessionId.slice(-8)} term=${termId} machineId=${machineId.slice(-6)}`);

    const gw = gateways.get(machineId);
    if (!gw || gw.readyState !== gw.OPEN) {
      sendBrowser(sock, { type: 'pty.exit', code: -2, termId, reason: 'gateway-offline' });
      try { sock.close(1011, 'gateway offline'); } catch {}
      return;
    }

    termRoutes.set(termId, { browser: sock, machineId });
    let owned = browserTerms.get(sock);
    if (!owned) {
      owned = new Set();
      browserTerms.set(sock, owned);
    }
    owned.add(termId);

    // Tell the browser its assigned id so it can label frames it sends back.
    sendBrowser(sock, { type: 'term.open', termId });

    // Ask THIS machine's gateway to spawn the pty. Default dimensions; the
    // browser will send a pty.resize once xterm's FitAddon settles.
    sendGatewayFor(machineId, { type: 'pty.open', termId, paneName: ctx.paneName, cols: 120, rows: 30 });

    // Heartbeat to keep the browser connection alive through Caddy.
    const heartbeat = setInterval(() => {
      if (sock.readyState !== sock.OPEN) return;
      try { sock.ping(); } catch {}
    }, 15_000);

    sock.on('message', (raw: RawData) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      // Always re-tag with our server-assigned termId — never trust the
      // client to address other terms.
      const ttype = String(msg.type || '');
      if (ttype === 'pty.input') {
        sendGatewayFor(machineId, { type: 'pty.input', termId, data: String(msg.data ?? '') });
      } else if (ttype === 'pty.resize') {
        sendGatewayFor(machineId, { type: 'pty.resize', termId, cols: Number(msg.cols), rows: Number(msg.rows) });
      } else if (ttype === 'ping') {
        sendBrowser(sock, { type: 'pong' });
      }
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      termRoutes.delete(termId);
      owned!.delete(termId);
      // Best-effort: tell THIS machine's gateway to drop the pty. If gateway
      // already gone, fine — its onExit cleaned up locally; if not yet but
      // shortly will be, the gateway-close handler will fan an exit out.
      sendGatewayFor(machineId, { type: 'pty.close', termId });
      console.log(`[term-ws] disconnected sid=${ctx.sessionId.slice(-8)} term=${termId}`);
    };

    sock.on('close', cleanup);
    sock.on('error', (err: Error) => {
      console.error('[term-ws] error:', err.message);
      cleanup();
    });
  });

  // ── Realtime voice-input WS server ───────────────────────────────────────
  // Everything about it (auth, framing, the DashScope task) is in
  // src/server/asr-ws.ts — this file only supplies the three things that are
  // genuinely local: how a key becomes a machine, how a session is checked, and
  // this process's Prisma client.
  const asrWs = createAsrWsServer({
    resolveMachineByKey,
    sessionBelongsTo: async (sessionId, machineId) =>
      !!(await prisma.chatSession.findFirst({ where: { id: sessionId, machineId }, select: { id: true } })),
    loadContext: (sessionId) => loadContext(prisma, sessionId),
    apiKey: () => process.env.DASHSCOPE_API_KEY,
    log: (...a) => console.log('[asr-ws]', ...a),
  });

  // ── HTTP → WS upgrade routing ────────────────────────────────────────────
  server.on('upgrade', async (req, socket, head) => {
    const url = req.url || '';
    try {
      if (url.startsWith(GATEWAY_PATH)) {
        const u = parseUrl(url, true);
        const key = gatewayUpgradeKey(req.headers, u.query.key);
        const machineId = await resolveMachineByKey(key);
        if (!machineId) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        // machineId scopes the connection — the connection handler keys its
        // slot in `gateways` by this so multiple hosts coexist cleanly.
        gatewayWss.handleUpgrade(req, socket, head, (ws) => {
          gatewayWss.emit('connection', ws, req, { machineId });
        });
        return;
      }

      if (asrWs.matches(url)) {
        await asrWs.handleUpgrade(req, socket, head);
        return;
      }

      const termMatch = url.match(TERM_PATH_RE);
      if (termMatch) {
        // Per spec, browser sends key in Sec-WebSocket-Protocol subprotocol
        // as `hermit-key.<token>` — avoids leaking it via proxy access logs.
        const proto = (req.headers['sec-websocket-protocol'] ?? '').toString();
        const tokens = proto.split(',').map((s) => s.trim()).filter(Boolean);
        const keyToken = tokens.find((t) => t.startsWith('hermit-key.'));
        const key = keyToken ? keyToken.slice('hermit-key.'.length) : '';
        // Terminal is machine-key only: a scoped agent-share token is NOT a
        // machine, so resolveMachineByKey returns null → 401. Shared agents have
        // no shell access (the isolation is a hard wall, not just UI).
        const machineId = await resolveMachineByKey(key);
        if (!machineId) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const sessionId = decodeURIComponent(termMatch[1]);
        const sess = await prisma.chatSession.findFirst({
          where: { id: sessionId, machineId },
          select: { id: true },
        });
        if (!sess) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }
        // Canonical pane name via the shared helper (mirrors @hermit-ui/tmux-driver).
        const paneName = tmuxPaneName(sessionId);

        // ws's WebSocketServer with handleProtocols echoes the first
        // hermit-key.* subprotocol back to the browser — required for the
        // handshake to succeed since the browser MUST get back at least
        // one of the protocols it offered.
        termWss.handleUpgrade(req, socket, head, (ws) => {
          termWss.emit('connection', ws, req, { sessionId, paneName, machineId });
        });
        return;
      }
    } catch (e) {
      console.error('[upgrade] error:', e instanceof Error ? e.message : e);
      try {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      } catch {}
      socket.destroy();
      return;
    }
    // Any other path — close cleanly. Next.js doesn't use WS itself in this
    // app (no HMR over WS in prod), so anything we don't recognize is a 404.
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  server.listen(port, () => {
    console.log(`[dashboard] custom server listening on :${port} (dev=${dev})`);
  });
});
