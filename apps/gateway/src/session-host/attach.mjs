#!/usr/bin/env node
// session-host/attach.mjs — what the SDK thinks is `claude`.
//
// The gateway hands the Agent SDK this file as `pathToClaudeCodeExecutable`.
// The SDK spawns it with exactly the argv it meant for the CLI, writes
// stream-json to its stdin and reads stream-json from its stdout — all of which
// this forwards, unread, to the session host. The real CLI is the host's child.
//
// So what dies with the gateway is THIS process, and the CLI does not notice.
// That is the whole trick, and it is why the gateway's SDK usage did not have
// to change: the transport, the control protocol, the argv and the SDK's
// version handling are all still the SDK's own.
//
// Plain .mjs, no TypeScript and no build step: the SDK spawns it directly with
// `executable: 'node'`, and a compile step in the path of every session spawn
// is a failure mode nobody would enjoy diagnosing.
import net from 'node:net';
import process from 'node:process';

const sock = process.env.HERMIT_HOST_SOCK;
const sessionId = process.env.HERMIT_SESSION_ID;
const bin = process.env.HERMIT_CLAUDE_BIN;
// Not a hardcoded 1: protocol.ts exists to let a host refuse a client it cannot
// serve, and the only client that ever sends an attach is this file. A literal
// here would keep saying 1 after the version moved, and be refused by the host
// it ships with. .mjs cannot import the .ts constant, so the gateway passes it
// the same way it passes the claude path.
const protocolVersion = Number(process.env.HERMIT_HOST_PROTOCOL ?? '1');

function die(msg) {
  // stderr, not stdout: stdout is the SDK's stream-json channel and anything
  // that is not a frame there is a parse error with a much worse message.
  process.stderr.write(`[attach] ${msg}\n`);
  process.exit(1);
}
if (!sock) die('HERMIT_HOST_SOCK is not set');
if (!sessionId) die('HERMIT_SESSION_ID is not set');
if (!bin) die('HERMIT_CLAUDE_BIN is not set');

// Connecting is retried, briefly. On a machine that just rebooted, pm2 brings
// the gateway and the host up together and the order is not guaranteed — a
// session spawned in that window would otherwise fail outright, which reads to
// the user as a broken chat rather than as a few seconds of waiting.
const CONNECT_DEADLINE = Date.now() + Number(process.env.HERMIT_HOST_CONNECT_MS ?? 10_000);
let conn;

function connect() {
  conn = net.connect(sock);
  conn.setNoDelay(true);
  conn.on('connect', onConnect);
  conn.on('data', onData);
  conn.on('error', (e) => {
    if (Date.now() < CONNECT_DEADLINE && !opened) {
      setTimeout(connect, 250);
      return;
    }
    die(`cannot reach the session host at ${sock}: ${e.message}`);
  });
  conn.on('close', () => {
    // The child outliving us is the point; us outliving the child is not.
    if (opened) process.exit(0);
    // A clean FIN before the handshake fires 'close' and not 'error', so
    // without this the process would simply run out of work and exit 0 — and
    // the SDK would see "claude produced no output and exited successfully",
    // which is the least diagnosable shape there is.
    die('the session host closed the connection before answering');
  });
}

function onConnect() {
  conn.write(JSON.stringify({
    v: protocolVersion,
    op: 'attach',
    sessionId,
    bin,
    // The SDK's own argv, forwarded rather than recomposed. It owns this list
    // and it changes with the SDK; a second copy in the gateway would drift.
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    // Credentials live in here. Never logged, on either side.
    env: { ...process.env },
  }) + '\n');
}

// The host answers with one JSON line and then the socket is raw. That line is
// for us, not for the SDK — forwarding it to stdout would be a frame the SDK
// cannot parse.
let head = '';
let opened = false;
function onData(d) {
  if (opened) { process.stdout.write(d); return; }
  head += d.toString('utf8');
  const nl = head.indexOf('\n');
  if (nl < 0) return;
  const line = head.slice(0, nl);
  const rest = head.slice(nl + 1);
  opened = true;
  let res;
  try { res = JSON.parse(line); } catch { die(`unreadable host reply: ${line.slice(0, 200)}`); }
  if (!res.ok) die(`host refused: ${res.error}`);
  process.stderr.write(`[attach] ${res.spawned ? 'spawned' : `adopted a child ${Math.round(res.ageMs / 1000)}s old`}, pid ${res.pid}\n`);
  process.stdin.pipe(conn);
  if (rest) process.stdout.write(rest);
}

connect();
