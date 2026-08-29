// GET /api/chat/stream?sessionId=<id> — Server-Sent Events stream of a chat
// session's message list. Replaces the browser's 600ms tRPC poll with a push:
// the handler emits the full message list whenever it changes. The browser
// writes each push into its React Query cache, and a client-side typewriter
// reveals new text.
//
// Wake-up: /api/sync/chat-message fires an in-process signal (server/chat-bus)
// after it lands rows; this handler subscribes and ticks immediately (a 100ms
// coalesce window absorbs the gateway's dense streaming flushes). The POLL_MS
// interval below is now only a safety net for lost signals / out-of-process
// writers, so it runs slow (2s) — no longer the latency path.
//
// Auth: x-asst-key header (same as every sync route). The client uses fetch()
// + a ReadableStream reader rather than EventSource precisely so it can send
// this header.

import { NextRequest } from 'next/server';
import { prisma } from '@/server/db';
import { resolveKey } from '@/server/auth';
import { messageProjection } from '@/server/message-digest';
import { subscribe as subscribeChat, subscribeStatus } from '@/server/chat-bus';
import { sessionStatusFrame, statusFrameSignature } from '@/server/session-status-frame';

export const dynamic = 'force-dynamic';

const POLL_MS = 2_000;        // safety-net poll; live pushes arrive via chat-bus
const TICK_DEBOUNCE_MS = 100; // coalesce burst signals from one streaming flush
const PING_MS = 15_000;
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 1000;

export async function GET(req: NextRequest) {
  // resolveKey accepts a machine key OR an agent share token; a scoped token can
  // only stream its own agent's session (the ownership check below adds agentName).
  const scope = await resolveKey(req.headers.get('x-asst-key') ?? '');
  if (!scope) return new Response('unauthorized', { status: 401 });
  const machine = scope.machine;

  const sessionId = req.nextUrl.searchParams.get('sessionId');
  if (!sessionId) return new Response('sessionId required', { status: 400 });

  // Window size mirrors the chat query's `limit` (grows as the user clicks
  // "load earlier"). We always stream the NEWEST `limit` rows — see
  // chat.listMessages for why oldest-N is the wrong slice.
  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitParam)))
    : DEFAULT_LIMIT;

  // The client passes skipInitial=1 right after it loaded this window via tRPC
  // chat.listMessages — so we PRIME the change-signal without re-emitting the same
  // rows, eliminating the open-time double-fetch (tRPC + SSE both shipping the
  // newest ~60). Genuine post-open changes still emit on the next tick.
  const skipInitial = req.nextUrl.searchParams.get('skipInitial') === '1';

  // `status=1` says the client understands a second frame type on this stream —
  // `event: status`, the session's runtime state (working/idle, alive, activity)
  // the moment the gateway writes it, instead of on the browser's next 5s poll.
  //
  // Opt-in for the same reason `delta` is: during a deploy a tab still running
  // the previous bundle is on this connection, and that bundle reads every frame
  // as a message push (it looks at `data:` and ignores `event:`). It would fold a
  // status frame into the timeline as an empty window. Old bundles do not ask, so
  // they never see one.
  const wantsStatus = req.nextUrl.searchParams.get('status') === '1';

  // `delta=1` says the client can merge a fragment: it gets {rows, gone} —
  // only what changed, plus the ids that have left the window — instead of the
  // whole window restated. Measured on a live session, a whole window is
  // 105–120KB and a turn changes it eight times, so the old shape spent about a
  // megabyte per turn per open tab to deliver a few kilobytes of new text.
  //
  // It is a flag and not a version bump because both shapes have to be on the
  // wire at once during a deploy: a tab still running the previous bundle asks
  // without it and must keep getting whole windows, or it would merge fragments
  // into a list it thinks is complete and render a conversation with holes.
  const wantsDelta = req.nextUrl.searchParams.get('delta') === '1';

  // `digest=1` says the client's window is the digested projection, so the rows
  // pushed into it must be too. This MUST agree with the `digest` the client
  // passed to chat.listMessages: the two transports merge by id into one list,
  // and a full-fidelity row landing in a digested window would re-expand a
  // capsule the reader had collapsed — and change its height under them.
  //
  // A flag, not a version bump, for the same reason as `delta` above: during a
  // deploy both shapes are on the wire at once.
  const project = messageProjection(req.nextUrl.searchParams.get('digest') === '1');

  // Ownership check up front — the per-tick query also scopes by machine, but
  // this gives a clean 404 instead of an empty stream.
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, machineId: machine.id, ...(scope.scopedAgent ? { agentName: scope.scopedAgent } : {}) },
    select: { id: true },
  });
  if (!session) return new Response('not found', { status: 404 });

  const encoder = new TextEncoder();
  let closed = false;

  // 提升到 start/cancel 共享的外层作用域（ReadableStream 的两个方法不共享
  // 彼此的函数作用域，只共享本层）。类型跟随 DOM lib 解析——Next 环境里
  // setTimeout/clearTimeout 走 DOM 签名，@types/node 的 NodeJS.Timeout 与它
  // 不匹配，故用 ReturnType（私有 alias，非导出契约）。
  type TimerHandle = ReturnType<typeof setTimeout>;
  let tickTimer: TimerHandle | undefined;
  let statusTimer: TimerHandle | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let unsubscribeChat: () => void = () => {};
  let unsubscribeStatus: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (s: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(s)); } catch { /* closed */ }
      };
      const sendMessages = (rows: unknown) => safeEnqueue(`event: messages\ndata: ${JSON.stringify(rows)}\n\n`);
      const sendPing = () => safeEnqueue(`: ping\n\n`);

      let lastSig = '';
      let lastEmit = Date.now();

      // ── the status channel ───────────────────────────────────────────────
      // Signal-driven only: there is no interval for this. It runs when the
      // gateway writes a snapshot for THIS session (chat-bus statusSubs), so a
      // session nobody is pushing about costs nothing, and a turn boundary
      // arrives about as fast as the gateway's POST commits.
      let lastStatusSig: string | null = null;
      const statusTick = async () => {
        if (closed) return;
        try {
          const row = await prisma.chatSession.findFirst({
            where: { id: sessionId, machineId: machine.id },
            select: {
              state: true, alive: true, activity: true, snapshotAt: true,
              closedAt: true, restartRequestedAt: true,
            },
          });
          if (!row || closed) return;
          const frame = sessionStatusFrame(row);
          const sig = statusFrameSignature(frame);
          if (sig === lastStatusSig) return;
          lastStatusSig = sig;
          lastEmit = Date.now();
          safeEnqueue(`event: status\ndata: ${JSON.stringify(frame)}\n\n`);
        } catch {
          // transient DB hiccup — the client's own 5s poll still carries state
        }
      };
      // Same coalesce shape as the message tick: the 8s snapshot push arrives as
      // one signal per session, but a turn boundary and a snapshot can land in
      // the same instant.
      const scheduleStatusTick = () => {
        if (closed || statusTimer) return;
        statusTimer = setTimeout(() => {
          statusTimer = undefined;
          void statusTick();
        }, TICK_DEBOUNCE_MS);
      };

      // What this connection has already put on the wire: row id → the updatedAt
      // it carried. That is the entire delta state, and it is bounded by the
      // window, so a long session costs no more to stream than a short one.
      const sent = new Map<string, number>();

      // The window, as ids only. Two columns off @@index([sessionId, createdAt]),
      // so asking "which rows are current and how fresh is each" costs about what
      // the MAX(updatedAt) probe costs — and unlike the probe it also notices a
      // row LEAVING, which is how `gone` gets computed.
      const readWindow = () =>
        prisma.chatMessage.findMany({
          where: { sessionId, session: { machineId: machine.id } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit,
          select: { id: true, updatedAt: true },
        });

      // Open with a byte, before any await.
      //
      // Next.js does not send the response headers until the body's first chunk,
      // so a stream that opens SILENTLY never completes its handshake. With
      // skipInitial=1 the branch below primes `lastSig` and emits nothing, so the
      // first chunk is the keep-alive ping — which only fires once a tick finds
      // PING_MS elapsed. Measured against 2eb401f, both through Caddy and
      // straight at the origin: fetch() resolved after 16.0s with 8 bytes (the
      // ping), against 12ms when an initial emit was requested.
      //
      // Sixteen seconds of an unresolved handshake would be survivable on its
      // own. It is not, because the browser marks itself connected the moment it
      // STARTS connecting and switches its fallback poll off for the duration
      // (see chat/page.tsx) — so that window had neither push nor poll, and a
      // reply already in this table sat invisible while the session header,
      // polled over a different query, had already gone back to "ready".
      // Teardown is registered BEFORE anything is awaited.
      //
      // It used to be the last statement of `start`, after an initial window
      // read and a first tick. A client that gave up inside that window — a
      // tab closed while the page was still loading, a reconnect racing its own
      // predecessor — arrived at a signal that had ALREADY aborted, and the DOM
      // is explicit that a listener added to one of those never runs. So
      // `shutdown` never ran, and the 2s safety-net poll it exists to clear kept
      // querying Postgres for the life of the server process.
      //
      // Measured against the previous commit: 40 streams opened and abandoned
      // mid-handshake took the database from 0.1 transactions/s with nobody
      // connected to 5.3/s, which at one query per 2s per stream is about ten
      // handlers still running for clients that had all gone.
      const shutdown = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        clearTimeout(tickTimer);
        clearTimeout(statusTimer);
        unsubscribeChat();
        unsubscribeStatus();
        try { controller.close(); } catch { /* already closed */ }
      };
      if (req.signal.aborted) {
        // Already gone. Nothing is subscribed or scheduled yet, so this is just
        // closing the controller — but it must happen, or the stream stays open.
        shutdown();
        return;
      }
      req.signal.addEventListener('abort', shutdown);

      safeEnqueue(': open\n\n');

      const tick = async () => {
        if (closed) return;
        try {
          // Cheap change probe: just MAX(updatedAt) across the session — an index
          // lookup on @@index([sessionId, updatedAt]), no heap COUNT(*). updatedAt
          // is @updatedAt so it bumps on every insert AND in-place upsert
          // (streaming growth), catching all changes. (A mid-session row deletion
          // wouldn't move MAX — but that never happens.) Only when it changes do
          // we pull + push the rows.
          const agg = await prisma.chatMessage.aggregate({
            where: { sessionId, session: { machineId: machine.id } },
            _max: { updatedAt: true },
          });
          const sig = `${agg._max.updatedAt?.getTime() ?? 0}`;
          if (sig === lastSig) {
            if (Date.now() - lastEmit > PING_MS) {
              lastEmit = Date.now();
              sendPing(); // keep proxies (Caddy/Xray) from dropping an idle conn
            }
            return;
          }
          lastSig = sig;

          // Something in the session moved. Which rows, though, is a separate
          // question: MAX(updatedAt) also moves when the gateway re-tails a
          // transcript and upserts rows OLDER than this window, and that must
          // not put a push on the wire.
          const window = await readWindow();
          const live = new Set(window.map((h) => h.id));
          const changed = window.filter((h) => sent.get(h.id) !== h.updatedAt.getTime());
          const gone = [...sent.keys()].filter((id) => !live.has(id));
          if (changed.length === 0 && gone.length === 0) return;

          // A delta client is told about `changed`; everyone else gets the window
          // restated, which is the only shape they can merge.
          const ids = wantsDelta ? changed.map((h) => h.id) : window.map((h) => h.id);
          const rows = ids.length
            ? await prisma.chatMessage.findMany({
                where: { id: { in: ids } },
                // Ascending for the timeline. Same narrow shape as
                // chat.listMessages so the client's merge-by-id sees identical
                // rows over both transports — including authoredBy, or a Brain
                // turn arriving live would render as the human's and only
                // correct itself on the next full fetch.
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { id: true, role: true, content: true, createdAt: true, authoredBy: true },
              })
            : [];
          lastEmit = Date.now();
          const payload = rows.map((r) => ({ ...r, content: project(r.content) }));
          sendMessages(wantsDelta ? { rows: payload, gone } : payload);

          for (const id of gone) sent.delete(id);
          for (const h of window) sent.set(h.id, h.updatedAt.getTime());
        } catch {
          // transient DB hiccup — keep the stream alive, retry next tick
        }
      };

      // Live wake-up: /api/sync/chat-message fired after writing rows. Coalesce
      // burst signals (a streaming flush POSTs many items back-to-back) into one
      // tick; the tick's own MAX(updatedAt) sig guard still skips no-op pushes.
      const scheduleTick = () => {
        if (closed || tickTimer) return;
        tickTimer = setTimeout(() => {
          tickTimer = undefined;
          void tick();
        }, TICK_DEBOUNCE_MS);
      };
      unsubscribeChat = subscribeChat(sessionId, scheduleTick);
      if (wantsStatus) {
        unsubscribeStatus = subscribeStatus(sessionId, scheduleStatusTick);
        // One frame at open, unconditionally: the tab may have been in the
        // background (this stream is torn down while hidden) and come back to a
        // session whose state changed in between, with no signal owed to it.
        void statusTick();
      }
      if (skipInitial) {
        // Record what the client already has from tRPC, without re-sending it.
        // `lastSig` is deliberately left empty: the first tick then runs its
        // window read, finds every row accounted for in `sent`, and emits
        // nothing — one cheap query instead of a duplicated window.
        // If this read fails, `sent` stays empty and the first tick emits the
        // whole window, which is a wasteful but correct fallback.
        try {
          for (const h of await readWindow()) sent.set(h.id, h.updatedAt.getTime());
          lastEmit = Date.now();
        } catch { /* fall through — first tick will emit */ }
      } else {
        await tick(); // initial snapshot ASAP — `sent` is empty, so it is a full window
      }
      // `cancel()` can run while the awaits above are still pending — it clears
      // an `interval` that does not exist yet, and `start` would then create one
      // nobody will ever clear. Both paths set `closed`, so this one check
      // closes the race from either side.
      if (closed) return;
      interval = setInterval(tick, POLL_MS);

    },
    cancel() {
      closed = true;
      clearInterval(interval);
      clearTimeout(tickTimer);
      clearTimeout(statusTimer);
      unsubscribeChat();
      unsubscribeStatus();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // tell any buffering proxy to flush immediately
    },
  });
}
