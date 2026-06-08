// GET /api/chat/stream?sessionId=<id> — Server-Sent Events stream of a chat
// session's message list. Replaces the browser's 600ms tRPC poll with a push:
// the handler polls Postgres every ~250ms (cheap, few concurrent viewers) and
// emits the full message list whenever it changes. The browser writes each push
// into its React Query cache, and a client-side typewriter reveals new text.
//
// Why a server-side poll loop and not LISTEN/NOTIFY: the gateway already writes
// block-level rows every couple hundred ms, Prisma can't LISTEN, and our viewer
// count is tiny. If that changes, swap the tick for a `pg` LISTEN on
// `chat_<sessionId>` fired from /api/sync/chat-message.
//
// Auth: x-asst-key header (same as every sync route). The client uses fetch()
// + a ReadableStream reader rather than EventSource precisely so it can send
// this header.

import { NextRequest } from 'next/server';
import { prisma } from '@/server/db';
import { resolveMachine } from '../../sync/route';
import { capMessageContent } from '@/server/message-cap';

export const dynamic = 'force-dynamic';

const POLL_MS = 600;
const PING_MS = 15_000;
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 1000;

export async function GET(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return new Response('unauthorized', { status: 401 });

  const sessionId = req.nextUrl.searchParams.get('sessionId');
  if (!sessionId) return new Response('sessionId required', { status: 400 });

  // Window size mirrors the chat query's `limit` (grows as the user clicks
  // "load earlier"). We always stream the NEWEST `limit` rows — see
  // chat.listMessages for why oldest-N is the wrong slice.
  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitParam)))
    : DEFAULT_LIMIT;

  // Ownership check up front — the per-tick query also scopes by machine, but
  // this gives a clean 404 instead of an empty stream.
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, machineId: machine.id },
    select: { id: true },
  });
  if (!session) return new Response('not found', { status: 404 });

  const encoder = new TextEncoder();
  let closed = false;

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
          if (sig !== lastSig) {
            lastSig = sig;
            lastEmit = Date.now();
            const rows = await prisma.chatMessage.findMany({
              where: { sessionId, session: { machineId: machine.id } },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: limit,
              // Same narrow shape as chat.listMessages so the client's
              // merge-by-id sees identical rows over both transports.
              select: { id: true, role: true, content: true, createdAt: true },
            });
            rows.reverse(); // newest window, ascending for the timeline
            sendMessages(rows.map((r) => ({ ...r, content: capMessageContent(r.content) })));
          } else if (Date.now() - lastEmit > PING_MS) {
            lastEmit = Date.now();
            sendPing(); // keep proxies (Caddy/Xray) from dropping an idle conn
          }
        } catch {
          // transient DB hiccup — keep the stream alive, retry next tick
        }
      };

      await tick(); // initial snapshot ASAP
      const interval = setInterval(tick, POLL_MS);

      const shutdown = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener('abort', shutdown);
    },
    cancel() { closed = true; },
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
