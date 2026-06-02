'use client';

// xterm.js bridge to the dashboard /api/term/<sid> WebSocket. Pure client
// component, lazy-imported by ../page.tsx so the chat bundle doesn't grow.
//
// Frame shape (multiplexed by termId, see apps/gateway/src/control-channel.ts):
//   browser → server: { type: 'pty.input',  data: <base64> }
//                     { type: 'pty.resize', cols, rows }
//   server → browser: { type: 'term.open',  termId }      (allocation ack)
//                     { type: 'pty.data',   termId, data: <base64> }
//                     { type: 'pty.exit',   termId, code, reason? }
//
// Reconnect policy:
//   • WS unexpectedly closes (network drop, server restart, etc.) → schedule a
//     reconnect with capped exponential backoff (1 → 1.7× → 30s cap).
//   • Server sends `pty.exit` → terminal is intentionally done; show a
//     "Reconnect" button instead of auto-respawning the pty.
//   • Component unmount → cleanly close socket without reconnect.
//
// Scrollback: defaults to 2000 lines (~12 MB per attached tab worst case).
// Power users can bump it via `localStorage.setItem('hermit-term-scrollback', '20000')`.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getStoredKey } from '@/app/providers';

type Status =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; nextDelayMs: number }
  | { kind: 'closed'; reason: string };

const SCROLLBACK_DEFAULT = 2000;
const SCROLLBACK_MIN = 100;
const SCROLLBACK_MAX = 100_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_FACTOR = 1.7;
const BACKOFF_MAX_MS = 30_000;

function readScrollbackPref(): number {
  if (typeof localStorage === 'undefined') return SCROLLBACK_DEFAULT;
  const raw = localStorage.getItem('hermit-term-scrollback');
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return SCROLLBACK_DEFAULT;
  return Math.max(SCROLLBACK_MIN, Math.min(SCROLLBACK_MAX, n));
}

function encodeInput(data: string): string {
  // base64(utf8) keeps the wire safe for control characters that JSON.stringify
  // would otherwise mangle (\x00 etc.).
  return btoa(unescape(encodeURIComponent(data)));
}

export function TerminalView({ sessionId }: { sessionId: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Defer pty.input frames until the server sends term.open. xterm onData
  // can fire before the WS is fully up if the user mashes keys early — and
  // also between reconnect attempts.
  const pendingInputRef = useRef<string[]>([]);
  const openedRef = useRef(false);
  // Manual = "we asked it to close on purpose (pty.exit or component unmount)".
  // Distinguishes intentional teardown from a network drop in onclose.
  const manualCloseRef = useRef(false);
  const unmountedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const backoffRef = useRef(BACKOFF_START_MS);
  const [status, setStatus] = useState<Status>({ kind: 'connecting' });
  // Triggered by the in-DOM "Reconnect" button; bumped to force the effect's
  // reconnect closure to run. (We can't call connect() directly from a
  // setState handler outside the effect.)
  const [reconnectNonce, setReconnectNonce] = useState(0);

  useEffect(() => {
    if (!wrapRef.current) return;
    unmountedRef.current = false;

    const term = new Terminal({
      fontFamily: '"Geist Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      // Match tmux's default colour assumptions; bright black is hard-coded
      // by many TUIs against a dark background.
      theme: {
        background: '#000000',
        foreground: '#e4e4e7',
        cursor: '#a1a1aa',
        cursorAccent: '#000000',
        selectionBackground: '#3f3f46',
      },
      allowProposedApi: true,
      scrollback: readScrollbackPref(),
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(wrapRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Send any keystroke as pty.input. Coalescing here would add lag; the
    // bursts that matter (paste) come in as one onData call already.
    term.onData((data) => {
      if (!openedRef.current) {
        pendingInputRef.current.push(data);
        return;
      }
      const sock = wsRef.current;
      if (!sock || sock.readyState !== sock.OPEN) {
        pendingInputRef.current.push(data);
        return;
      }
      try {
        sock.send(JSON.stringify({ type: 'pty.input', data: encodeInput(data) }));
      } catch {
        // socket vanished mid-send
      }
    });

    // ── Resize handling ──────────────────────────────────────────────────────
    let resizeRaf = 0;
    const sendResize = () => {
      if (!openedRef.current) return;
      const { cols, rows } = term;
      const s = wsRef.current;
      if (!s || s.readyState !== s.OPEN) return;
      try { s.send(JSON.stringify({ type: 'pty.resize', cols, rows })); } catch {}
    };
    const onResize = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        try { fit.fit(); } catch {}
        sendResize();
      });
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(wrapRef.current);

    // ── Toolbar quick-key channel (Esc / ^C / ^B d from the page header) ─────
    const onCustomInput = (e: Event) => {
      const data = (e as CustomEvent<{ data: string }>).detail?.data;
      if (typeof data !== 'string') return;
      const s = wsRef.current;
      if (!openedRef.current || !s || s.readyState !== s.OPEN) {
        pendingInputRef.current.push(data);
        return;
      }
      try {
        s.send(JSON.stringify({ type: 'pty.input', data: encodeInput(data) }));
      } catch {}
    };
    window.addEventListener('hermit-term-input', onCustomInput);

    // Client-side heartbeat — keep Caddy from dropping a quiet conn. Server
    // sends its own ping too; both legs surviving one-sided proxies matters.
    const pingTimer = window.setInterval(() => {
      const s = wsRef.current;
      if (s && s.readyState === s.OPEN) {
        try { s.send(JSON.stringify({ type: 'ping' })); } catch {}
      }
    }, 20_000);

    // ── WebSocket bring-up (re-callable for reconnect) ───────────────────────
    const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${wsScheme}://${window.location.host}/api/term/${encodeURIComponent(sessionId)}`;
    const key = getStoredKey();

    function connect() {
      if (unmountedRef.current) return;
      // Close any stale prior socket without triggering reconnect logic.
      const prior = wsRef.current;
      if (prior && prior.readyState <= prior.OPEN) {
        manualCloseRef.current = true;
        try { prior.close(1000, 'reconnecting'); } catch {}
      }
      openedRef.current = false;
      setStatus({ kind: 'connecting' });

      // Sec-WebSocket-Protocol carries the dashboard key. Hidden from access
      // logs, unlike a query-string token. See server.ts handleProtocols echo.
      const sock = new WebSocket(url, [`hermit-key.${key}`]);
      wsRef.current = sock;

      sock.onopen = () => {
        // The pty.open round-trip lands shortly via term.open; only declare
        // "connected" after that so the status badge isn't lying about a half-
        // open state.
      };
      sock.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'term.open') {
          openedRef.current = true;
          backoffRef.current = BACKOFF_START_MS;
          setStatus({ kind: 'connected' });
          // Drain queued keys.
          const queued = pendingInputRef.current.splice(0);
          for (const data of queued) {
            try {
              sock.send(JSON.stringify({ type: 'pty.input', data: encodeInput(data) }));
            } catch {}
          }
          // Push current size now that we have a server-side pty waiting.
          sendResize();
          return;
        }
        if (msg.type === 'pty.data' && typeof msg.data === 'string') {
          try {
            const bin = atob(msg.data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            // TextDecoder so multi-byte UTF-8 split across frame boundaries
            // doesn't render as garbage. The 16ms gateway flush usually keeps
            // sequences whole; for now per-frame decode covers the common case.
            term.write(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
          } catch { /* bad base64 — drop */ }
          return;
        }
        if (msg.type === 'pty.exit') {
          openedRef.current = false;
          const reason = msg.reason ? String(msg.reason) : `exit ${msg.code ?? 0}`;
          // pty.exit is the server saying "this terminal is done". Don't auto-
          // reconnect — the user might have detached on purpose. The closed
          // status renders a Reconnect button.
          manualCloseRef.current = true;
          setStatus({ kind: 'closed', reason });
          try { term.writeln(`\r\n\x1b[2;33m[disconnected: ${reason}]\x1b[0m`); } catch {}
          try { sock.close(1000, 'pty exit'); } catch {}
          return;
        }
        // 'pong' from the server — nothing to do.
      };
      sock.onclose = (ev) => {
        openedRef.current = false;
        if (unmountedRef.current) return;
        if (manualCloseRef.current) {
          // pty.exit or manual reconnect — leave status as already set.
          manualCloseRef.current = false;
          return;
        }
        // Unexpected close — schedule reconnect with backoff.
        const delay = backoffRef.current;
        setStatus({ kind: 'reconnecting', nextDelayMs: delay });
        try { term.writeln(`\r\n\x1b[2;33m[connection lost (${ev.code || '?'}) — reconnecting in ${Math.round(delay / 1000)}s…]\x1b[0m`); } catch {}
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          backoffRef.current = Math.min(BACKOFF_MAX_MS, Math.floor(delay * BACKOFF_FACTOR));
          connect();
        }, delay);
      };
      sock.onerror = () => {
        // 'error' is followed by 'close' from the browser; let onclose handle it.
      };
    }

    // Focus once mounted so users can start typing immediately.
    term.focus();
    connect();

    return () => {
      unmountedRef.current = true;
      cancelAnimationFrame(resizeRaf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('hermit-term-input', onCustomInput);
      ro.disconnect();
      window.clearInterval(pingTimer);
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      manualCloseRef.current = true;
      const sock = wsRef.current;
      if (sock) {
        try { sock.close(1000, 'unmount'); } catch {}
      }
      try { term.dispose(); } catch {}
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
    // reconnectNonce is intentionally a dep so clicking "Reconnect" while the
    // effect is in a 'closed' state will tear down + rebuild the xterm and
    // socket cleanly. (Inside `connect()` we'd otherwise need to thread the
    // function back out to button handlers — this is simpler.)
  }, [sessionId, reconnectNonce]);

  const onManualReconnect = () => {
    backoffRef.current = BACKOFF_START_MS;
    setReconnectNonce((n) => n + 1);
  };

  return (
    <div className="flex-1 min-h-0 relative bg-black">
      <div ref={wrapRef} className="absolute inset-0 px-2 py-1" />
      {status.kind !== 'connected' && (
        <div className="absolute top-2 right-2 flex items-center gap-2">
          <div className="text-[10px] font-mono px-2 py-1 rounded bg-zinc-900/80 border border-zinc-700 text-zinc-300 pointer-events-none">
            {status.kind === 'connecting' && 'connecting…'}
            {status.kind === 'reconnecting' && `reconnecting in ${Math.round(status.nextDelayMs / 1000)}s…`}
            {status.kind === 'closed' && `disconnected — ${status.reason}`}
          </div>
          {status.kind === 'closed' && (
            <button
              type="button"
              onClick={onManualReconnect}
              className="text-[10px] font-mono px-2 py-1 rounded bg-zinc-100 hover:bg-white text-zinc-900 border border-zinc-300 cursor-pointer transition-colors"
            >
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
