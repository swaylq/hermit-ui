// The /api/asr socket, driven over a real TCP socket with a real `ws` client on
// one end and a fake ASR stream on the other.
//
// Everything here is a guard that only fails in production if it isn't tested:
// who gets in, what a rejected upgrade looks like on the wire, and whether audio
// that arrives after the user pressed ✓ can still reach a task that is closing.
// The DashScope leg is deliberately faked — it is exercised for real elsewhere
// (see docs/realtime-voice-input-design.md); what is under test is the glue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import { createAsrWsServer, type AsrWsDeps } from './asr-ws';
import type { AsrStream, AsrStreamEvents, AsrStreamOpts } from './asr-stream';

const KEY = 'machine-key';
const MACHINE = 'm1';
const SESSION = 'sess-1';

interface FakeStream extends AsrStream {
  readonly pushed: Buffer[];
  readonly opts: AsrStreamOpts;
  readonly events: AsrStreamEvents;
  readonly finished: () => boolean;
}

function harness(over: Partial<AsrWsDeps> = {}) {
  let last: FakeStream | null = null;
  const deps: AsrWsDeps = {
    resolveMachineByKey: async (k) => (k === KEY ? MACHINE : null),
    sessionBelongsTo: async (sid, mid) => sid === SESSION && mid === MACHINE,
    loadContext: async () => 'agent: rathole 隧道已经重连上了',
    apiKey: () => 'ds-key',
    log: () => {},
    createStream: (opts, events) => {
      const pushed: Buffer[] = [];
      let done = false;
      const s: FakeStream = {
        pushed,
        opts,
        events,
        finished: () => done,
        push: (b) => { pushed.push(b); },
        finish: async () => { done = true; },
        close: () => {},
      };
      last = s;
      return s;
    },
    ...over,
  };
  const asr = createAsrWsServer(deps);
  const server: Server = createServer((_req, res) => { res.statusCode = 426; res.end(); });
  // An upgraded socket is no longer an HTTP connection, so server.close() waits
  // on it forever and closeAllConnections() doesn't reach it. Track them here so
  // teardown is unconditional and no test has to remember to hang up.
  const upgraded = new Set<Duplex>();
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    if (asr.matches(req.url || '')) void asr.handleUpgrade(req, socket, head);
    else { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); }
  });
  return {
    asr,
    server,
    stream: () => last,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
      }),
    close: () =>
      new Promise<void>((r) => {
        asr.close();
        for (const sock of upgraded) sock.destroy();
        upgraded.clear();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function connect(port: number, path: string, key: string) {
  return new WebSocket(`ws://127.0.0.1:${port}${path}`, [`hermit-key.${key}`]);
}

/** Collect JSON frames until `until` returns true (or the socket closes). */
function collect(ws: WebSocket, until: (msgs: Record<string, unknown>[]) => boolean) {
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const msgs: Record<string, unknown>[] = [];
    const t = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(msgs)}`)), 4000);
    const finish = () => { clearTimeout(t); resolve(msgs); };
    ws.on('message', (d) => {
      msgs.push(JSON.parse(d.toString()));
      if (until(msgs)) finish();
    });
    ws.on('close', finish);
    ws.on('error', () => { /* close follows */ });
  });
}

test('a wrong key is refused at the handshake, before any stream exists', { timeout: 5000 }, async () => {
  const h = harness();
  const port = await h.listen();
  const ws = connect(port, `/api/asr/${SESSION}`, 'not-the-key');
  const err = await new Promise<Error>((r) => ws.on('error', r));
  assert.match(err.message, /401/);
  assert.equal(h.stream(), null, 'no ASR task was opened for an unauthorized socket');
  await h.close();
});

test('a session that is not this machine’s is a 404, not a silent success', { timeout: 5000 }, async () => {
  const h = harness();
  const port = await h.listen();
  const ws = connect(port, '/api/asr/someone-elses-session', KEY);
  const err = await new Promise<Error>((r) => ws.on('error', r));
  assert.match(err.message, /404/);
  await h.close();
});

test('no provider key configured says so and closes, rather than hanging', { timeout: 5000 }, async () => {
  const h = harness({ apiKey: () => undefined });
  const port = await h.listen();
  const ws = connect(port, `/api/asr/${SESSION}`, KEY);
  const msgs = await collect(ws, (m) => m.length >= 1);
  assert.deepEqual(msgs[0], {
    type: 'error',
    message: 'realtime transcription not configured',
    fatal: true,
  });
  await h.close();
});

test('audio goes up, transcript comes down, stop closes the run', { timeout: 5000 }, async () => {
  const h = harness();
  const port = await h.listen();
  const ws = connect(port, `/api/asr/${SESSION}`, KEY);
  await new Promise((r) => ws.on('open', r));

  const got = collect(ws, (m) => m.some((x) => x.type === 'done'));
  ws.send(Buffer.from([1, 2, 3, 4]));
  ws.send(Buffer.from([5, 6]));
  await new Promise((r) => setTimeout(r, 30));

  const s = h.stream()!;
  assert.equal(Buffer.concat(s.pushed).length, 6, 'both binary frames reached the stream');
  s.events.onReady();
  s.events.onPartial('把rathole的隧道');
  s.events.onFinal(1, '把Red Hole的隧道重启一下。');
  s.events.onPolished(1, '把 rathole 的隧道重启一下。');
  ws.send(JSON.stringify({ type: 'stop' }));

  const msgs = await got;
  assert.deepEqual(msgs.map((m) => m.type), ['ready', 'partial', 'final', 'polished', 'done']);
  assert.equal(msgs[2].segId, 1);
  assert.equal(msgs[3].text, '把 rathole 的隧道重启一下。');
  assert.ok(s.finished(), 'finish() ran before done was sent');
  await h.close();
});

test('audio sent after stop is dropped — it belongs to no sentence', { timeout: 5000 }, async () => {
  const h = harness();
  const port = await h.listen();
  const ws = connect(port, `/api/asr/${SESSION}`, KEY);
  await new Promise((r) => ws.on('open', r));
  ws.send(Buffer.from([1, 2]));
  await new Promise((r) => setTimeout(r, 30));
  ws.send(JSON.stringify({ type: 'stop' }));
  ws.send(Buffer.from([3, 4, 5, 6]));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(Buffer.concat(h.stream()!.pushed).length, 2, 'only the pre-stop frame was forwarded');
  await h.close();
});

test('the run gets the conversation context and the minimal style by default', { timeout: 5000 }, async () => {
  const h = harness();
  const port = await h.listen();
  const ws = connect(port, `/api/asr/${SESSION}`, KEY);
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 20));
  const { opts } = h.stream()!;
  assert.equal(opts.style, 'minimal');
  assert.equal(opts.polish, true);
  assert.match(opts.context, /rathole/);
  await h.close();
});

test('?style=rewrite is honoured; anything else falls back to minimal', { timeout: 5000 }, async () => {
  const h = harness();
  const port = await h.listen();

  const a = connect(port, `/api/asr/${SESSION}?style=rewrite`, KEY);
  await new Promise((r) => a.on('open', r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.stream()!.opts.style, 'rewrite');
  a.close();

  const b = connect(port, `/api/asr/${SESSION}?style=nonsense`, KEY);
  await new Promise((r) => b.on('open', r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.stream()!.opts.style, 'minimal');
  b.close();

  await h.close();
});

test('matches() only claims its own paths', () => {
  const { asr } = harness();
  assert.ok(asr.matches('/api/asr/abc'));
  assert.ok(asr.matches('/api/asr/abc?style=rewrite'));
  assert.ok(!asr.matches('/api/term/abc'));
  assert.ok(!asr.matches('/api/asr/'));
  assert.ok(!asr.matches('/api/asr/a/b'));
  asr.close();
});
