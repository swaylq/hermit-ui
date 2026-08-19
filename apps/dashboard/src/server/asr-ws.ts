// The /api/asr/<sessionId> WebSocket endpoint: auth, routing, and the pipe
// between a browser's audio frames and one DashScope streaming-ASR task.
//
// It lives here rather than inline in ../server.ts for one reason — server.ts
// cannot be imported. It is a script that boots Next.js and binds a port, so
// anything written inside it is untestable by construction, and this file is all
// guards: who may open a socket, what happens to audio that arrives after
// 'stop', what a half-open connection costs. Every dependency it needs is passed
// in (including the stream factory), so a test can drive the whole thing over a
// real socket with a fake ASR on the far side and no network at all.
//
// Auth is the terminal's scheme, deliberately: the key rides in a
// `hermit-key.<token>` subprotocol so it stays out of proxy access logs, and it
// must be a MACHINE key — resolveMachineByKey returns null for a scoped
// agent-share token, so shared agents 401 here and keep the batch voice path.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket as WSWebSocket, type RawData } from 'ws';
import { createAsrStream, type AsrStream, type AsrStreamEvents, type AsrStreamOpts } from './asr-stream';
import type { PolishStyle } from './transcribe-polish';

const ASR_PATH_RE = /^\/api\/asr\/([^/?#]+)(?:\?([^#]*))?$/;

/** A run this long has stopped being dictation and started being a leak. */
const MAX_SESSION_MS = 30 * 60_000;
/** Frames bigger than this are not audio from our client. */
const MAX_FRAME_BYTES = 256 * 1024;

export interface AsrWsDeps {
  /** Machine key → machineId, or null. Scoped share tokens must return null. */
  resolveMachineByKey: (key: string) => Promise<string | null>;
  /** Does this session exist and belong to that machine? */
  sessionBelongsTo: (sessionId: string, machineId: string) => Promise<boolean>;
  /** Recent conversation for the polish step. Must never throw. */
  loadContext: (sessionId: string) => Promise<string>;
  /** Read at connect time, so a key added later doesn't need a restart. */
  apiKey: () => string | undefined;
  /** Injectable for tests; production uses the real DashScope stream. */
  createStream?: (opts: AsrStreamOpts, events: AsrStreamEvents) => AsrStream;
  log?: (...args: unknown[]) => void;
}

export interface AsrWsServer {
  /** Is this upgrade ours? Cheap, synchronous — call before doing any work. */
  matches: (url: string) => boolean;
  /** Authorize and take over the socket. Writes its own HTTP error responses. */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
  /** For tests / shutdown. */
  close: () => void;
}

export function createAsrWsServer(deps: AsrWsDeps): AsrWsServer {
  const makeStream = deps.createStream ?? createAsrStream;
  const log = deps.log ?? ((...a: unknown[]) => console.log('[asr-ws]', ...a));

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    // The browser offered a subprotocol, so the 101 must name one back or it
    // rejects the connection. Echo the key token it sent.
    handleProtocols: (protocols) => {
      for (const p of protocols) {
        if (typeof p === 'string' && p.startsWith('hermit-key.')) return p;
      }
      return false;
    },
  });

  wss.on('connection', (sock: WSWebSocket, _req: IncomingMessage, ctx: { sessionId: string; context: string; style: PolishStyle }) => {
    const send = (payload: unknown) => {
      if (sock.readyState !== sock.OPEN) return;
      try { sock.send(JSON.stringify(payload)); } catch { /* socket vanished mid-send */ }
    };

    const key = deps.apiKey();
    if (!key) {
      // Say so plainly rather than failing obscurely: the client drops straight
      // back to press-and-hold instead of retrying a socket that can't work.
      send({ type: 'error', message: 'realtime transcription not configured', fatal: true });
      try { sock.close(1011, 'no asr key'); } catch {}
      return;
    }

    log(`connected sid=${ctx.sessionId.slice(-8)} style=${ctx.style} ctx=${ctx.context.length}B`);
    let finishing = false;

    const stream = makeStream(
      { apiKey: key, context: ctx.context, style: ctx.style, polish: true },
      {
        onReady: () => send({ type: 'ready' }),
        onPartial: (text) => send({ type: 'partial', text }),
        onFinal: (segId, text) => send({ type: 'final', segId, text }),
        onPolished: (segId, text) => send({ type: 'polished', segId, text }),
        onError: (message, fatal) => send({ type: 'error', message, fatal }),
      },
    );

    const heartbeat = setInterval(() => {
      if (sock.readyState !== sock.OPEN) return;
      try { sock.ping(); } catch {}
    }, 15_000);
    const cap = setTimeout(() => {
      log(`session cap reached sid=${ctx.sessionId.slice(-8)}`);
      try { sock.close(1000, 'session cap'); } catch {}
    }, MAX_SESSION_MS);

    const doFinish = () => {
      if (finishing) return;
      finishing = true;
      void stream.finish().then(() => {
        send({ type: 'done' });
        try { sock.close(1000, 'done'); } catch {}
      });
    };

    sock.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        if (finishing) return; // audio after 'stop' belongs to no sentence
        stream.push(toBuffer(raw));
        return;
      }
      let msg: { type?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === 'stop') doFinish();
      else if (msg?.type === 'ping') send({ type: 'pong' });
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      clearTimeout(cap);
      stream.close();
      log(`disconnected sid=${ctx.sessionId.slice(-8)}`);
    };
    sock.on('close', cleanup);
    sock.on('error', (err: Error) => {
      console.error('[asr-ws] error:', err.message);
      cleanup();
    });
  });

  return {
    matches: (url: string) => ASR_PATH_RE.test(url),

    async handleUpgrade(req, socket, head) {
      const m = (req.url || '').match(ASR_PATH_RE);
      if (!m) { reject(socket, 404); return; }

      const proto = (req.headers['sec-websocket-protocol'] ?? '').toString();
      const token = proto.split(',').map((t) => t.trim()).find((t) => t.startsWith('hermit-key.'));
      const machineId = await deps.resolveMachineByKey(token ? token.slice('hermit-key.'.length) : '');
      if (!machineId) { reject(socket, 401); return; }

      const sessionId = decodeURIComponent(m[1]);
      if (!(await deps.sessionBelongsTo(sessionId, machineId))) { reject(socket, 404); return; }

      // Which polish the user picked on this device. Not a secret, so the query
      // string is fine; anything unrecognized resolves to the realtime default,
      // which is `minimal` — the ask is the user's own sentence, recognized
      // accurately, and a per-sentence rewrite works against that.
      const style: PolishStyle = new URLSearchParams(m[2] ?? '').get('style') === 'rewrite' ? 'rewrite' : 'minimal';
      const context = await deps.loadContext(sessionId);

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, { sessionId, context, style });
      });
    },

    close() {
      wss.close();
    },
  };
}

function reject(socket: Duplex, status: 401 | 404) {
  const text = status === 401 ? 'Unauthorized' : 'Not Found';
  socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
  socket.destroy();
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw as ArrayBuffer);
}
