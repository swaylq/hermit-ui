// Notifications inbox — one aggregated, time-sorted feed of everything unread
// across ALL of the machine's agents: chat sessions (lastMessageAt > lastReadAt)
// and finished cron runs not yet read (readAt null, status != 'running'). It does
// NOT introduce its own read-state — it reads/writes the very same ChatSession
// .lastReadAt and CronRun.readAt that the chat sidebar and /cron page use, so a
// "read" here clears the red dot everywhere and vice-versa.
//
// Two alert conditions ride alongside the unread items: host pressure, and sessions
// where the human asked something and nothing answered. Neither is "unread" — you
// SENT the stalled message, so its session is the most-read thing you own — which is
// exactly why they need their own row here. See docs/unanswered-alert-design.md.
//
// Owner-only: every procedure is machineProcedure, which rejects scoped share
// keys — a shared single-agent link never sees the global inbox.

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { fmtGB } from '@/lib/host-health';

// A host's red-pressure alert is "pending" (show in the inbox) iff it was raised
// (redAlertAt set, on a red crossing) and not yet read past that raise. Recovery
// clears redAlertAt in the sync route, so this also goes false on recovery.
function hostAlertPending(s: { redAlertAt: Date | null; alertReadAt: Date | null } | null | undefined): boolean {
  if (!s?.redAlertAt) return false;
  return !s.alertReadAt || s.alertReadAt.getTime() < s.redAlertAt.getTime();
}

// Unread = lastMessageAt > lastReadAt — a column-to-column comparison Prisma can't
// express in a `where`, so (exactly like isSessionUnread on the client) we pull the
// most-recent sessions and filter in JS. Unread sessions are by definition recently
// active, so a generous recent-window scan captures them without an unbounded fetch.
const SESSION_SCAN = 300;
const PREVIEW_LEN = 140;
const DEFAULT_PAGE = 30; // notifications feed page size (the feed is cursor-paginated)

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const b of content as Array<{ type?: string; text?: string }>) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
      return b.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LEN);
    }
  }
  return null;
}

// The sessions the unanswered sweep has flagged and "mark all read" hasn't yet
// acknowledged. Reads the persisted flag through its partial index rather than
// recomputing the predicate — this runs on the always-on 5s poll, and normally matches
// zero rows. Raising/clearing the flag is the sweep's job (server/unanswered.ts).
//
// A plain `acked IS NULL` suffices for "not yet acknowledged" because the sweep resets
// unansweredAckedMsgId to null every time it writes a new unansweredMsgId — so a
// non-null ack always refers to the flag currently sitting in the row, never a stale one.
const PENDING_UNANSWERED = { unansweredMsgId: { not: null }, unansweredAckedMsgId: null } as const;

type UnreadSession = { id: string; lastMessageAt: Date | null; lastReadAt: Date | null };
function isUnread(s: UnreadSession): boolean {
  if (!s.lastMessageAt) return false;
  return s.lastMessageAt.getTime() > (s.lastReadAt?.getTime() ?? 0);
}

// Lightweight scan (no message bodies) → unread session ids, for counts + markAllRead.
async function scanUnreadSessionIds(machineId: string): Promise<string[]> {
  const rows = await prisma.chatSession.findMany({
    where: { machineId },
    orderBy: { lastMessageAt: 'desc' },
    take: SESSION_SCAN,
    select: { id: true, lastMessageAt: true, lastReadAt: true },
  });
  return rows.filter(isUnread).map((s) => s.id);
}

export const notificationsRouter = router({
  // The feed: unread chat sessions + unread cron runs, merged newest-first. The cron
  // backlog is what makes the inbox heavy, so it's CURSOR-PAGINATED (`cursor` = the
  // firedAt ms of the last cron shown; a page returns the next `limit` older runs).
  // Chat is NOT paginated: unread chat is sparse (unread ⟹ recently active) and
  // bounded, so it's scanned once on the first page and rides there — paginating it
  // by small takes would churn through pages of read sessions for ~0 unread items.
  // Header totals come from the separate `counts` query; this carries no aggregate.
  feed: machineProcedure
    .input(z.object({ cursor: z.number().nullish(), limit: z.number().int().min(1).max(100).default(DEFAULT_PAGE) }))
    .query(async ({ ctx, input }) => {
      const machineId = ctx.machine.id;
      const limit = input.limit;
      const before = input.cursor != null ? new Date(input.cursor) : null;

      // Batch 1 — all independent: recent sessions (no message bodies; the first
      // page JS-filters unread, later pages skip chat since it all rides page one),
      // the machine's cron ids, and the host stat (first page only).
      const [sessionRows, cronIdRows, hostStat, stalledRows] = await Promise.all([
        before
          ? Promise.resolve([])
          : prisma.chatSession.findMany({
              where: { machineId },
              orderBy: { lastMessageAt: 'desc' },
              take: SESSION_SCAN,
              select: { id: true, agentName: true, title: true, lastMessageAt: true, lastReadAt: true },
            }),
        prisma.cron.findMany({ where: { machineId }, select: { id: true } }),
        before ? Promise.resolve(null) : prisma.hostStat.findUnique({ where: { machineId } }),
        before
          ? Promise.resolve([])
          : prisma.chatSession.findMany({
              where: { machineId, ...PENDING_UNANSWERED },
              select: { id: true, agentName: true, title: true, unansweredMsgId: true },
            }),
      ]);
      const cronIds = cronIdRows.map((c) => c.id);
      const unreadSessions = sessionRows.filter(isUnread);

      // Batch 2 — the cron page (explicit `cronId IN` so the (cronId, firedAt) WHERE
      // readAt IS NULL partial index serves it) and each unread session's latest
      // message ("what's new") via one guaranteed-single-row findFirst per unread
      // session. (An earlier `distinct: ['sessionId']` here made Prisma fetch a whole
      // session's message history in-memory — the inbox's real ~0.8s "still slow" cost;
      // findFirst on the (sessionId, createdAt) index is ~1ms.)
      const [cronRuns, latestMsgs, stalledMsgs] = await Promise.all([
        cronIds.length > 0
          ? prisma.cronRun.findMany({
              where: { cronId: { in: cronIds }, readAt: null, status: { not: 'running' }, ...(before ? { firedAt: { lt: before } } : {}) },
              orderBy: { firedAt: 'desc' },
              take: limit,
              select: {
                id: true,
                firedAt: true,
                status: true,
                output: true,
                cron: { select: { id: true, title: true, prompt: true, agentName: true } },
              },
            })
          : Promise.resolve([]),
        unreadSessions.length > 0
          ? Promise.all(
              unreadSessions.map((s) =>
                prisma.chatMessage.findFirst({
                  where: { sessionId: s.id },
                  orderBy: { createdAt: 'desc' },
                  select: { sessionId: true, content: true },
                }),
              ),
            ).then((rows) => rows.filter((r): r is NonNullable<typeof r> => r != null))
          : Promise.resolve([]),
        // The flagged message itself, for its text and its timestamp. Point lookups by
        // id, and there are normally none — the whole fleet raised three of these in
        // two months.
        stalledRows.length > 0
          ? prisma.chatMessage.findMany({
              where: { id: { in: stalledRows.map((s) => s.unansweredMsgId as string) } },
              select: { id: true, content: true, createdAt: true },
            })
          : Promise.resolve([]),
      ]);

      const previewBySession = new Map<string, string | null>();
      for (const m of latestMsgs) previewBySession.set(m.sessionId, firstText(m.content));

      const chatItems = unreadSessions.map((s) => {
        const preview = previewBySession.get(s.id) ?? null;
        return {
          kind: 'chat' as const,
          key: `chat:${s.id}`,
          agentName: s.agentName,
          title: s.title?.trim() || preview || 'Untitled session',
          preview,
          at: s.lastMessageAt as Date,
          sessionId: s.id,
        };
      });

      const cronItems = cronRuns.map((r) => ({
        kind: 'cron' as const,
        key: `cron:${r.id}`,
        agentName: r.cron.agentName,
        title: r.cron.title?.trim() || r.cron.prompt.slice(0, 60),
        // Tail of the run output — the end is where the result / error usually lands.
        preview: r.output ? r.output.replace(/\s+/g, ' ').trim().slice(-PREVIEW_LEN) : null,
        at: r.firedAt,
        status: r.status, // 'ok' | 'fail'
        cronId: r.cron.id,
        runId: r.id,
      }));

      const hostItems = !before && hostAlertPending(hostStat)
        ? [{
            kind: 'host' as const,
            key: `host:${machineId}`,
            agentName: ctx.machine.alias || ctx.machine.name,
            title: 'Host under memory pressure',
            preview: `free ${fmtGB(hostStat!.ramFreeMb)} GB · load ${hostStat!.loadAvg1?.toFixed(1) ?? '—'} · ${hostStat!.cpuCount ?? '—'} cores`,
            at: hostStat!.redAlertAt as Date,
          }]
        : [];

      // A stalled session is NOT unread (you sent the last message, so you've read
      // every word in it) — which is precisely why it needs its own item. `at` is when
      // the question was asked, so it sorts into the timeline at the moment it started
      // going unanswered.
      const askedById = new Map(stalledMsgs.map((m) => [m.id, m]));
      const stallItems = stalledRows.flatMap((s) => {
        const asked = askedById.get(s.unansweredMsgId as string);
        if (!asked) return []; // message deleted out from under the flag
        const preview = firstText(asked.content);
        return [{
          kind: 'stall' as const,
          key: `stall:${s.id}`,
          agentName: s.agentName,
          title: s.title?.trim() || preview || 'Untitled session',
          preview: preview ? `No reply to: ${preview}` : 'No reply to your last message',
          at: asked.createdAt,
          sessionId: s.id,
        }];
      });

      // Only cron paginates (it's dense — the WHERE already restricts to unread, so
      // every fetched row is shown). More iff cron filled its page; the next cursor is
      // its oldest run's firedAt. Chat + host are fully delivered on the first page.
      const hasMore = cronRuns.length >= limit;
      const nextCursor = hasMore ? cronRuns[cronRuns.length - 1].firedAt.getTime() : null;

      const items = [...hostItems, ...stallItems, ...chatItems, ...cronItems].sort(
        (a, b) => b.at.getTime() - a.at.getTime(),
      );
      return { items, nextCursor };
    }),

  // Cheap counts for the sidebar bell badge + filter labels (no bodies). Polled
  // globally while the dashboard is open, so it stays bounded and select-light.
  counts: machineProcedure.query(async ({ ctx }) => {
    const machineId = ctx.machine.id;
    const [sessionRows, cron, hostStat, stall] = await Promise.all([
      prisma.chatSession.findMany({
        where: { machineId },
        orderBy: { lastMessageAt: 'desc' },
        take: SESSION_SCAN,
        select: { id: true, lastMessageAt: true, lastReadAt: true },
      }),
      prisma.cronRun.count({ where: { cron: { machineId }, readAt: null, status: { not: 'running' } } }),
      prisma.hostStat.findUnique({ where: { machineId } }),
      prisma.chatSession.count({ where: { machineId, ...PENDING_UNANSWERED } }),
    ]);
    const chat = sessionRows.filter(isUnread).length;
    const host = hostAlertPending(hostStat) ? 1 : 0;
    return { chat, cron, stall, total: chat + cron + host + stall };
  }),

  // Clear the whole inbox: stamp lastReadAt on every currently-unread session and
  // readAt on every finished-unread run. Same fields/semantics as the per-item
  // mutations (chat.markRead / cron.markRunRead) → red dots clear site-wide.
  markAllRead: machineProcedure.mutation(async ({ ctx }) => {
    const machineId = ctx.machine.id;
    const now = new Date();
    const ids = await scanUnreadSessionIds(machineId);
    const [chatRes, cronRes] = await Promise.all([
      ids.length > 0
        ? prisma.chatSession.updateMany({ where: { id: { in: ids }, machineId }, data: { lastReadAt: now } })
        : Promise.resolve({ count: 0 }),
      prisma.cronRun.updateMany({
        where: { cron: { machineId }, readAt: null, status: { not: 'running' } },
        data: { readAt: now },
      }),
    ]);
    // Ack a pending host alert too — stamp alertReadAt past redAlertAt so it drops
    // from the feed until the next red crossing.
    const hostStat = await prisma.hostStat.findUnique({ where: { machineId } });
    if (hostAlertPending(hostStat)) {
      await prisma.hostStat.update({ where: { machineId }, data: { alertReadAt: now } });
    }
    // Ack stalled sessions by copying the flag, never by clearing it: clearing
    // unansweredMsgId would look to the next sweep like a fresh stall and push again.
    // The session keeps owing you a reply — you've just said you know.
    const stalled = await prisma.chatSession.findMany({
      where: { machineId, ...PENDING_UNANSWERED },
      select: { id: true, unansweredMsgId: true },
    });
    for (const s of stalled) {
      await prisma.chatSession.update({
        where: { id: s.id },
        data: { unansweredAckedMsgId: s.unansweredMsgId },
      });
    }
    return { ok: true, chat: chatRes.count, cron: cronRes.count, stall: stalled.length };
  }),
});
