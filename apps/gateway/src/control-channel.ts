// Mac-side outbound WebSocket to the dashboard that multiplexes interactive
// terminal sessions over a single long-lived control connection.
//
// Architecture (option A from the 2026-05-29 design):
//
//   browser xterm.js
//     ⇄ wss://dash.swaylab.ai/api/term/<sid>   ← per-tab transient WS
//   dashboard custom server (apps/dashboard/server.ts)
//     ⇄ ws  /api/gateway/ws?key=…              ← THIS module, persistent + outbound
//   Mac gateway (this process)
//     ⇄ node-pty → `tmux attach -t hermit-<paneN>`
//
// We open from the Mac side so the dashboard never needs to reach the Mac
// (which it can't anyway — Mac has no public hostname; the rathole tunnel is
// for Caddy:8443, not arbitrary inbound TCP). Reconnect with capped
// exponential backoff. Auth is the gateway's existing ASST_KEY in query
// string — keeps consistent with how api.ts already authenticates to the
// dashboard via the x-asst-key header.
//
// Protocol (JSON frames, multiplexed by termId):
//   inbound (dashboard → gateway):
//     { type:'pty.open',   termId, paneName, cols, rows }
//     { type:'pty.input',  termId, data: <base64 utf8> }
//     { type:'pty.resize', termId, cols, rows }
//     { type:'pty.close',  termId }
//   outbound (gateway → dashboard):
//     { type:'pty.data',   termId, data: <base64 utf8> }
//     { type:'pty.exit',   termId, code }
//
// Throttling: each pty's stdout is coalesced into ~16ms windows before being
// frame-sent. A `tmux attach` redraw can emit thousands of small writes per
// frame; one WS message per write would crush both legs of the bridge. 16ms
// keeps interactive latency under one render tick while collapsing redraw
// storms to single frames.

import WebSocket from 'ws';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { DASHBOARD_URL, ASST_KEY } from './config';

type IPty = ReturnType<typeof pty.spawn>;

interface PtyEntry {
  pty: IPty;
  // Coalesce buffer + flush timer so a redraw storm doesn't fan out into
  // thousands of WS frames.
  pending: Buffer[];
  flushTimer: NodeJS.Timeout | null;
}

const FLUSH_MS = 16;
// Cap concurrent ptys to prevent runaway resource use if a buggy client opens
// in a tight loop. 32 is generous — sway typically watches one session at a
// time.
const MAX_PTYS = 32;

const PING_MS = 15_000;

// Zombie watchdog: every minute, probe each pty's pid with signal 0. If the
// kernel says ESRCH the child is gone but node-pty's onExit never fired —
// rare but observed when pty closes during a syscall the lib doesn't handle.
// Synthetic exit frame keeps the browser side in sync; without this the
// route in the dashboard would stay alive until the user closed the tab.
const ZOMBIE_CHECK_MS = 60_000;
let zombieTimer: NodeJS.Timeout | null = null;

const ptys = new Map<string, PtyEntry>();

let ws: WebSocket | null = null;
let backoffMs = 1_000;
const BACKOFF_MAX_MS = 30_000;

function dashboardWsUrl(): string {
  // DASHBOARD_URL is http(s)://…; convert scheme + append our WS path.
  // The dashboard's custom server upgrades /api/gateway/ws to a WS handler.
  const u = new URL(DASHBOARD_URL);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/gateway/ws';
  u.search = `?key=${encodeURIComponent(ASST_KEY)}`;
  return u.toString();
}

function safeSend(payload: unknown) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {
    console.error('[control] send failed:', e instanceof Error ? e.message : e);
  }
}

function scheduleFlush(termId: string, entry: PtyEntry) {
  if (entry.flushTimer) return;
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null;
    if (entry.pending.length === 0) return;
    const merged = Buffer.concat(entry.pending);
    entry.pending = [];
    safeSend({ type: 'pty.data', termId, data: merged.toString('base64') });
  }, FLUSH_MS);
}

function closePty(termId: string, opts: { sendExit?: boolean; code?: number } = {}) {
  const entry = ptys.get(termId);
  if (!entry) return;
  ptys.delete(termId);
  if (entry.flushTimer) clearTimeout(entry.flushTimer);
  try {
    entry.pty.kill();
  } catch {
    // already dead — fine
  }
  if (opts.sendExit) {
    safeSend({ type: 'pty.exit', termId, code: opts.code ?? 0 });
  }
}

function openPty(termId: string, paneName: string, cols: number, rows: number) {
  if (ptys.has(termId)) {
    // Idempotent: re-open with same id is a no-op. Don't error — the dashboard
    // may resend if the WS reconnected mid-session.
    return;
  }
  if (ptys.size >= MAX_PTYS) {
    safeSend({ type: 'pty.exit', termId, code: -1 });
    console.warn(`[control] pty cap reached (${MAX_PTYS}); refusing termId=${termId}`);
    return;
  }

  // We don't validate paneName against a server-side allowlist — the dashboard
  // already enforces session→machine ownership before allocating the termId,
  // and `tmux attach -t <name>` fails cleanly if the pane doesn't exist
  // (returns exit 1, pty.onExit fires). The shell stays in our process tree.
  const safePaneName = String(paneName).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safePaneName) {
    safeSend({ type: 'pty.exit', termId, code: -1 });
    return;
  }

  let child: IPty;
  try {
    // Hand a real PATH to tmux (launchd-bare PATH on macOS doesn't include
    // /opt/homebrew/bin). Run in a login-ish shell so the user's tmux config
    // (~/.tmux.conf) is honored — same UX as the user attaching from their
    // own terminal.
    child = pty.spawn(
      'tmux',
      // Enable mouse mode for the session, THEN attach — so the browser's scroll
      // wheel scrolls tmux's scrollback (copy-mode). xterm only ever receives
      // tmux's current viewport, so without this there is nothing to scroll. The
      // `;` is a tmux command separator passed as a literal argv element (node-pty
      // spawns tmux directly, no shell). Session-scoped: doesn't touch other panes.
      ['set-option', '-t', safePaneName, 'mouse', 'on', ';', 'attach', '-t', safePaneName],
      {
        name: 'xterm-256color',
        cols: clampDim(cols, 80),
        rows: clampDim(rows, 24),
        cwd: process.env.HOME ?? '/tmp',
        env: {
          ...process.env,
          PATH: process.env.PATH
            ? `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`
            : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
          TERM: 'xterm-256color',
        },
      },
    );
  } catch (e) {
    console.error(`[control] pty spawn failed for ${safePaneName}:`, e instanceof Error ? e.message : e);
    safeSend({ type: 'pty.exit', termId, code: -1 });
    return;
  }

  const entry: PtyEntry = { pty: child, pending: [], flushTimer: null };
  ptys.set(termId, entry);

  child.onData((data: string) => {
    // node-pty's onData hands us a string; treat as utf8 bytes for safe
    // base64 round-trip (xterm.js writes the decoded bytes back).
    entry.pending.push(Buffer.from(data, 'utf8'));
    scheduleFlush(termId, entry);
  });

  child.onExit(({ exitCode }) => {
    // Flush any tail data before the exit frame so the user sees `[exited]`
    // or whatever the shell printed last.
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    if (entry.pending.length > 0) {
      const merged = Buffer.concat(entry.pending);
      entry.pending = [];
      safeSend({ type: 'pty.data', termId, data: merged.toString('base64') });
    }
    ptys.delete(termId);
    safeSend({ type: 'pty.exit', termId, code: exitCode ?? 0 });
  });
}

function clampDim(n: number, fallback: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x) || x < 2) return fallback;
  if (x > 1000) return 1000;
  return x;
}

function handleFrame(raw: WebSocket.RawData) {
  let msg: any;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  const termId = typeof msg.termId === 'string' ? msg.termId : '';
  switch (msg.type) {
    case 'pty.open': {
      if (!termId || typeof msg.paneName !== 'string') return;
      openPty(termId, msg.paneName, msg.cols ?? 80, msg.rows ?? 24);
      return;
    }
    case 'pty.input': {
      const entry = ptys.get(termId);
      if (!entry) return;
      if (typeof msg.data !== 'string') return;
      try {
        const buf = Buffer.from(msg.data, 'base64');
        entry.pty.write(buf.toString('utf8'));
      } catch {
        // bad base64 — drop
      }
      return;
    }
    case 'pty.resize': {
      const entry = ptys.get(termId);
      if (!entry) return;
      try {
        entry.pty.resize(clampDim(msg.cols, 80), clampDim(msg.rows, 24));
      } catch {
        // pty already dead — onExit will clean up
      }
      return;
    }
    case 'pty.close': {
      closePty(termId);
      return;
    }
    case 'ping': {
      safeSend({ type: 'pong' });
      return;
    }
    default:
      return;
  }
}

function connect() {
  if (!ASST_KEY) {
    console.error('[control] no ASST_KEY; cannot connect to dashboard');
    return;
  }
  const url = dashboardWsUrl();
  // Don't log the key — bake the redaction in so an accidental copy never
  // leaks the secret to logs.
  const redacted = url.replace(/key=[^&]+/, 'key=***');
  console.log(`[control] connecting to ${redacted}`);

  ws = new WebSocket(url, {
    handshakeTimeout: 10_000,
  });

  const pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {}
    }
  }, PING_MS);

  ws.on('open', () => {
    backoffMs = 1_000;
    console.log('[control] connected');
  });

  ws.on('message', (raw) => {
    handleFrame(raw);
  });

  ws.on('pong', () => {
    // proxy-keep-alive nudge; nothing else to do
  });

  ws.on('close', (code, reason) => {
    clearInterval(pingTimer);
    console.log(`[control] closed code=${code} reason=${reason.toString().slice(0, 200)}; reconnecting in ${backoffMs}ms`);
    // Kill any still-open ptys — without a control channel they're
    // unreachable, and tmux pane lives on regardless (the user can re-attach
    // later through a fresh open frame).
    for (const id of [...ptys.keys()]) closePty(id);
    ws = null;
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(BACKOFF_MAX_MS, Math.floor(backoffMs * 1.7));
  });

  ws.on('error', (err) => {
    // Per ws docs: 'error' is always followed by 'close', so we let close
    // schedule the reconnect. Just log here.
    console.error('[control] error:', err.message);
  });
}

function sweepZombies() {
  for (const [termId, entry] of [...ptys.entries()]) {
    const pid = entry.pty.pid;
    if (!pid) continue;
    try {
      process.kill(pid, 0);  // signal 0 = existence check, no signal delivered
    } catch (e) {
      // ESRCH (no such process) is the case we care about — node-pty's onExit
      // never fired, but the child is dead. EPERM would mean it exists but
      // we can't signal it (shouldn't happen for our own child) — leave it.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') continue;
      console.warn(`[control] zombie pty term=${termId} pid=${pid} reaped`);
      if (entry.flushTimer) clearTimeout(entry.flushTimer);
      // Drain anything we still had buffered before announcing exit.
      if (entry.pending.length > 0) {
        const merged = Buffer.concat(entry.pending);
        entry.pending = [];
        safeSend({ type: 'pty.data', termId, data: merged.toString('base64') });
      }
      ptys.delete(termId);
      safeSend({ type: 'pty.exit', termId, code: -3, reason: 'zombie-reaped' });
    }
  }
}

let started = false;
export function startControlChannel() {
  if (started) return;
  started = true;
  // Defer a tick so the initial pushAgents/etc. block in index.ts doesn't
  // race a connect log line into the middle of startup banners.
  setTimeout(connect, 100);
  if (!zombieTimer) {
    zombieTimer = setInterval(sweepZombies, ZOMBIE_CHECK_MS);
    // Don't keep the event loop alive purely for the watchdog — the WS reconnect
    // setTimeouts already pin the loop and clean shutdown is what we want here.
    zombieTimer.unref?.();
  }
}

export function shutdownControlChannel() {
  started = false;
  if (zombieTimer) {
    clearInterval(zombieTimer);
    zombieTimer = null;
  }
  for (const id of [...ptys.keys()]) closePty(id);
  if (ws) {
    try { ws.close(1000, 'shutdown'); } catch {}
    ws = null;
  }
}
