// session-host/host.ts — the process that holds the claude children, so that
// restarting the gateway stops being the same thing as ending every session.
//
// Why this cannot be solved inside the gateway: whoever holds a claude child's
// stdin owns its life. The CLI reads stream-json from stdin and exits on EOF —
// that is how `shutdownClaudeSdk()` ends a session on purpose — and the write
// end of that pipe is a file descriptor in the gateway process. The official
// SDK spawns with `stdio: ['pipe','pipe','pipe']` and exposes neither `detached`
// nor the stdio options, so there is no flag that changes this. The only shape
// that works is a second process that does not restart when the gateway does.
//
// What this process is NOT: it does not parse a frame, does not know what a
// turn is, does not talk to the dashboard and has no database access. It holds
// children and moves bytes. Every interpretation — event translation, activity,
// dedupe, persistence — stays in the gateway, because the gateway is what
// changes every day and this is what must not. If you find yourself adding a
// feature here, check first whether it belongs on the other side of the socket.
//
// How the gateway reaches it: the SDK is told that `claude` lives at
// session-host/attach.mjs. That shim connects here and pipes stdio through, so
// the SDK's own transport, argv, control protocol and version handling are
// untouched — what dies with a gateway restart is the shim, not the CLI.
//
// Verified against a real Claude Code before any of this was written
// (projects/gateway-restart-survival/proto): a second client attaches to a
// running child and gets the same session id, the same model and a warm
// context with no `--resume`; a client killed mid-turn leaves the turn running,
// and the next client sees its conclusion.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  HOST_PROTOCOL_VERSION,
  parseRequest,
  splitFirstLine,
  type AttachRequest,
  type HostResponse,
} from './protocol';

/**
 * A child with nobody attached for this long is killed.
 *
 * Not a cleanup nicety — it is the bound on the one thing this process makes
 * possible to leak. Each claude child is ~300 MB, and without the gateway
 * nothing else on the machine knows they exist. A gateway restart reattaches in
 * seconds and Layer 1's resume window is 15 minutes, so half an hour means
 * "the gateway is not coming back", not "the gateway is busy".
 */
const DEFAULT_IDLE_KILL_MS = 30 * 60_000;

interface Session {
  sessionId: string;
  child: ChildProcess;
  startedAt: number;
  client: net.Socket | null;
  /** When the last client detached; 0 while one is attached. */
  detachedAt: number;
}

export interface SessionHost {
  readonly socketPath: string;
  sessions(): string[];
  close(): Promise<void>;
}

export interface HostOptions {
  socketPath: string;
  log?: (line: string) => void;
  idleKillMs?: number;
  /** Test seam: how often to look for children nobody is attached to. */
  sweepMs?: number;
}

export function startSessionHost(opts: HostOptions): Promise<SessionHost> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const idleKillMs = opts.idleKillMs ?? DEFAULT_IDLE_KILL_MS;
  const sessions = new Map<string, Session>();

  function reply(conn: net.Socket, res: HostResponse): void {
    try {
      conn.write(`${JSON.stringify(res)}\n`);
    } catch { /* the client left mid-answer; nothing to do about it */ }
  }

  function endChild(s: Session, why: string): void {
    log(`[host] ${s.sessionId.slice(0, 8)} killing child pid=${s.child.pid} (${why})`);
    try {
      // End stdin first: that is the CLI's own orderly shutdown, and it lets it
      // finish writing the transcript instead of losing the tail to a signal.
      s.child.stdin?.end();
    } catch { /* already closed */ }
    try { s.child.kill('SIGTERM'); } catch { /* already gone */ }
    sessions.delete(s.sessionId);
  }

  function spawnChild(req: AttachRequest): Session {
    // NOTE: req.env is never logged. It carries the child's credentials.
    const child = spawn(req.bin, req.argv, {
      cwd: req.cwd,
      env: req.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const s: Session = { sessionId: req.sessionId, child, startedAt: Date.now(), client: null, detachedAt: Date.now() };

    child.stdout.on('data', (d: Buffer) => {
      // Straight through, unparsed. The host does not know what a frame is.
      if (s.client && !s.client.destroyed) s.client.write(d);
    });
    // The SDK's own stderr tail belongs to the shim, not to the CLI, so a
    // child's stderr would otherwise go nowhere. Labelled and sent to this
    // process's log, which pm2 keeps — better for diagnosis than a per-turn
    // buffer that only exists while a client is attached.
    child.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString('utf8').split('\n')) {
        if (line.trim()) log(`[host:${s.sessionId.slice(0, 8)}] ${line}`);
      }
    });
    child.on('exit', (code, signal) => {
      log(`[host] ${s.sessionId.slice(0, 8)} child exited code=${code} signal=${signal}`);
      // Closing the socket is how the gateway finds out: its shim exits, the
      // SDK sees "claude" exit, and the runtime reports the turn as cut. That
      // path already exists and already says the right thing.
      try { s.client?.end(); } catch { /* already gone */ }
      if (sessions.get(s.sessionId) === s) sessions.delete(s.sessionId);
    });
    child.on('error', (e) => log(`[host] ${s.sessionId.slice(0, 8)} spawn failed: ${e.message}`));

    sessions.set(req.sessionId, s);
    log(`[host] ${req.sessionId.slice(0, 8)} spawned pid=${child.pid} cwd=${req.cwd}`);
    return s;
  }

  function onAttach(conn: net.Socket, req: AttachRequest, rest: string): void {
    let s = sessions.get(req.sessionId);
    const spawned = !s;
    if (!s) s = spawnChild(req);

    // Last attach wins. A gateway that did not quite finish dying must not end
    // up driving the same CLI as the one that replaced it — two writers on one
    // stdin is the shape of every "two Claude Codes on one transcript" bug this
    // project has already paid for once.
    if (s.client && !s.client.destroyed) {
      log(`[host] ${req.sessionId.slice(0, 8)} superseding the previous client`);
      try { s.client.destroy(); } catch { /* already gone */ }
    }
    s.client = conn;
    s.detachedAt = 0;

    reply(conn, { ok: true, spawned, pid: s.child.pid ?? 0, ageMs: Date.now() - s.startedAt });
    if (rest) s.child.stdin?.write(rest);

    conn.on('data', (d: Buffer) => { s!.child.stdin?.write(d); });
    // THE POINT: a client going away does not touch the child. Not its stdin,
    // not a signal, nothing. That is the difference between a gateway restart a
    // session survives and the one it does not.
    const detach = () => {
      if (s!.client === conn) {
        s!.client = null;
        s!.detachedAt = Date.now();
        log(`[host] ${req.sessionId.slice(0, 8)} client detached; child untouched`);
      }
    };
    conn.on('close', detach);
    conn.on('error', detach);
  }

  const server = net.createServer((conn) => {
    conn.setNoDelay(true);
    let head = '';
    let opened = false;
    const onHead = (d: Buffer) => {
      if (opened) return;
      head += d.toString('utf8');
      const split = splitFirstLine(head);
      if (!split) {
        if (head.length > 1024 * 1024) { conn.destroy(); } // no opening line is ever this long
        return;
      }
      opened = true;
      conn.off('data', onHead);
      const req = parseRequest(split.line);
      if (!req) {
        reply(conn, { ok: false, error: `unreadable request, or not protocol v${HOST_PROTOCOL_VERSION}` });
        conn.end();
        return;
      }
      if (req.op === 'list') {
        reply(conn, {
          ok: true,
          sessions: [...sessions.values()].map((s) => ({
            sessionId: s.sessionId,
            pid: s.child.pid ?? 0,
            ageMs: Date.now() - s.startedAt,
            attached: s.client != null,
            idleMs: s.detachedAt ? Date.now() - s.detachedAt : 0,
          })),
        });
        conn.end();
        return;
      }
      if (req.op === 'kill') {
        const s = sessions.get(req.sessionId);
        if (s) endChild(s, 'asked to');
        reply(conn, { ok: true, killed: !!s });
        conn.end();
        return;
      }
      onAttach(conn, req, split.rest);
    };
    conn.on('data', onHead);
    conn.on('error', () => { /* a client that hangs up before it speaks is not an event */ });
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (!s.client && s.detachedAt && now - s.detachedAt > idleKillMs) {
        endChild(s, `nobody attached for ${Math.round((now - s.detachedAt) / 60_000)}m`);
      }
    }
  }, opts.sweepMs ?? 60_000);
  sweep.unref();

  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(opts.socketPath), { recursive: true });
    // A stale socket file from a host that was SIGKILLed would make listen()
    // fail with EADDRINUSE forever. Removing it is safe: if a live host were
    // listening, the connect probe below would have reached it.
    try { fs.rmSync(opts.socketPath, { force: true }); } catch { /* nothing there */ }
    server.on('error', reject);
    server.listen(opts.socketPath, () => {
      // Same-user only. The env in an attach request carries credentials.
      try { fs.chmodSync(opts.socketPath, 0o600); } catch { /* best effort */ }
      log(`[host] listening on ${opts.socketPath} (protocol v${HOST_PROTOCOL_VERSION}, pid ${process.pid})`);
      resolve({
        socketPath: opts.socketPath,
        sessions: () => [...sessions.keys()],
        close: () =>
          new Promise((done) => {
            clearInterval(sweep);
            // The children DO die with a host that is shutting down cleanly,
            // and that is not a compromise — it is the honest reading of what
            // this process is. Nothing can adopt a running child's stdio: the
            // pipes are file descriptors in this process, which is the same
            // fact that made the gateway unable to keep them in the first
            // place. Leaving them would produce children nobody holds and
            // nobody can reach, which the gateway's orphan reaper would shoot
            // seconds later anyway.
            //
            // So: this process is the one that must almost never restart. It is
            // ~250 lines that know nothing about any gateway feature, which is
            // the entire reason the socket protocol is one message wide. When
            // it does have to restart, Layer 1 resumes the sessions it ended.
            for (const s of [...sessions.values()]) endChild(s, 'host shutting down');
            server.close(() => done());
            try { fs.rmSync(opts.socketPath, { force: true }); } catch { /* gone */ }
          }),
      });
    });
  });
}
