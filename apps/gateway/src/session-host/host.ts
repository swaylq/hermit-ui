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
      if (!s.client || s.client.destroyed) return;
      // Guarded even after the destroyed check: the client can go away between
      // the check and the write, and an unhandled throw here would take down
      // the process that is holding every session on the machine.
      try { s.client.write(d); } catch { /* the gateway left mid-frame */ }
    });
    // A write to a dead child's stdin raises EPIPE on the stream, and an
    // unhandled 'error' event throws. The child exiting is ordinary — the CLI
    // ends a session by exiting — so this must never be able to kill the host.
    child.stdin.on('error', (e) => log(`[host] ${s.sessionId.slice(0, 8)} stdin: ${e.message}`));
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

  function onAttach(conn: net.Socket, req: AttachRequest, rest: Buffer): void {
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
    // The handshake line goes out BEFORE this connection can receive child
    // output. Today both statements are in one synchronous block so nothing
    // could interleave anyway; ordering them this way means a future edit that
    // puts an await between them cannot silently corrupt the stream by letting
    // a frame arrive where the client expects its reply.
    reply(conn, { ok: true, spawned, pid: s.child.pid ?? 0, ageMs: Date.now() - s.startedAt });
    s.client = conn;
    s.detachedAt = 0;

    const toChild = (d: Buffer) => {
      try { s!.child.stdin?.write(d); } catch { /* child gone; its exit handler ends the socket */ }
    };
    if (rest.length > 0) toChild(rest);

    conn.on('data', toChild);
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

  // Connections that have not yet become a session's client. Tracked only so
  // close() can drop them; an attached one is reachable through its session.
  const unattached = new Set<net.Socket>();

  const server = net.createServer((conn) => {
    conn.setNoDelay(true);
    unattached.add(conn);
    conn.on('close', () => unattached.delete(conn));
    let head: Buffer = Buffer.alloc(0);
    let opened = false;
    // A client that connects and then says nothing holds the process open:
    // server.close() waits for every connection, so `close()` would never
    // resolve and pm2 would have to SIGKILL the one process on the machine that
    // is holding every session. `nc -U <sock>` and walk away is the whole repro.
    const handshake = setTimeout(() => {
      if (!opened) { log('[host] a client connected and never spoke; dropping it'); conn.destroy(); }
    }, 5_000);
    handshake.unref();
    conn.on('close', () => clearTimeout(handshake));
    const onHead = (d: Buffer) => {
      if (opened) return;
      head = head.length === 0 ? d : Buffer.concat([head, d]);
      const split = splitFirstLine(head);
      if (!split) {
        if (head.length > 1024 * 1024) { conn.destroy(); } // no opening line is ever this long
        return;
      }
      opened = true;
      clearTimeout(handshake);
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
      unattached.delete(conn);
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

  return new Promise(async (resolve, reject) => {
    // 0700 at creation, not chmod-after: a directory that is briefly 0755 is a
    // window in which another user can watch the socket appear.
    fs.mkdirSync(path.dirname(opts.socketPath), { recursive: true, mode: 0o700 });

    // Probe before unlinking. A stale socket file from a host that was SIGKILLed
    // makes listen() fail with EADDRINUSE forever, so it has to go — but
    // removing one a LIVE host is listening on is far worse than not starting:
    // the second host serves every new attach, spawns its own claude for a
    // session the first one is already running, and two Claude Codes append to
    // one transcript. The first host also deletes the socket out from under the
    // second when it eventually closes. Refuse loudly instead.
    //
    // (An earlier version of this file claimed "the connect probe below" in a
    // comment and did not have one. That is the bug this paragraph replaces.)
    const occupied = await new Promise<boolean>((done) => {
      const probe = net.connect(opts.socketPath);
      const settle = (v: boolean) => { try { probe.destroy(); } catch { /* gone */ } done(v); };
      probe.on('connect', () => settle(true));
      probe.on('error', () => settle(false)); // ENOENT (no file) or ECONNREFUSED (stale)
      setTimeout(() => settle(false), 1_000).unref();
    });
    if (occupied) {
      reject(new Error(`another session host is already listening on ${opts.socketPath} — refusing to take it over`));
      return;
    }
    try { fs.rmSync(opts.socketPath, { force: true }); } catch { /* nothing there */ }

    // Same-user only, and the mask is set BEFORE listen() so the socket is never
    // world-anything even briefly. An attach request carries the child's
    // credentials in its env.
    const prevMask = process.umask(0o077);
    server.on('error', (e) => { process.umask(prevMask); reject(e); });
    server.listen(opts.socketPath, () => {
      process.umask(prevMask);
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
            // server.close() waits for every open connection, including one
            // that connected and never spoke — which would make this promise
            // never resolve and leave pm2 to SIGKILL us.
            for (const c of unattached) { try { c.destroy(); } catch { /* gone */ } }
            server.close(() => done());
            try { fs.rmSync(opts.socketPath, { force: true }); } catch { /* gone */ }
          }),
      });
    });
  });
}
