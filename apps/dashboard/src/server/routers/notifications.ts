// Notifications inbox — one aggregated, time-sorted feed of everything unread
// across ALL of the machine's agents: chat sessions (lastMessageAt > lastReadAt)
// and finished cron runs not yet read (readAt null, status != 'running'). It does
// NOT introduce its own read-state — it reads/writes the very same ChatSession
// .lastReadAt and CronRun.readAt that the chat sidebar and /cron page use, so a
// "read" here clears the red dot everywhere and vice-versa.
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
  // The feed: unread chat sessions + unread cron runs, merged newest-first, CURSOR-
  // PAGINATED by time so the inbox loads a page at a time instead of the whole
  // (cron-dominated) backlog on entry. `cursor` is a ms timestamp — a page returns
  // items strictly older than nothing on the first call, then older than the cursor.
  // The two streams are paginated independently and merged; the "safe boundary" (see
  // below) is what keeps that merge gap-free across pages. Header totals come from the
  // separate `counts` query, so this response carries no aggregate count.
  feed: machineProcedure
    .input(z.object({ cursor: z.number().nullish(), limit: z.number().int().min(1).max(100).default(DEFAULT_PAGE) }))
    .query(async ({ ctx, input }) => {
      const machineId = ctx.machine.id;
      const limit = input.limit;
      const before = input.cursor != null ? new Date(input.cursor) : null;

      const [sessionRows, cronRuns, hostStat] = await Promise.all([
        prisma.chatSession.findMany({
          where: { machineId, ...(before ? { lastMessageAt: { lt: before } } : {}) },
          orderBy: { lastMessageAt: 'desc' },
          take: limit,
          select: {
            id: true,
            agentName: true,
            title: true,
            lastMessageAt: true,
            lastReadAt: true,
            // Latest message (any role) → the "what's new" preview. Same nested-take
            // shape chat.listSessions already uses, so no extra round-trip per session.
            messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true } },
          },
        }),
        prisma.cronRun.findMany({
          where: { cron: { machineId }, readAt: null, status: { not: 'running' }, ...(before ? { firedAt: { lt: before } } : {}) },
          orderBy: { firedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            firedAt: true,
            status: true,
            output: true,
            cron: { select: { id: true, title: true, prompt: true, agentName: true } },
          },
        }),
        // The host alert is a single item — only the (unpaginated) first page carries it.
        before ? Promise.resolve(null) : prisma.hostStat.findUnique({ where: { machineId } }),
      ]);

      const chatItems = sessionRows.filter(isUnread).map((s) => {
        const preview = firstText(s.messages[0]?.content);
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

      // Safe merge boundary: a stream that filled its page may have more rows below
      // its last one, so we can only safely emit down to the NEWEST such last-row
      // timestamp — everything ≥ boundary is fully known from both streams. Items
      // below are deferred to the next page (which re-queries each stream < cursor).
      // A stream that returned < limit is exhausted for this window → −∞ (no floor).
      const chatBoundary = sessionRows.length >= limit ? (sessionRows[sessionRows.length - 1].lastMessageAt?.getTime() ?? -Infinity) : -Infinity;
      const cronBoundary = cronRuns.length >= limit ? cronRuns[cronRuns.length - 1].firedAt.getTime() : -Infinity;
      const boundary = Math.max(chatBoundary, cronBoundary);
      const hasMore = Number.isFinite(boundary);

      const body = [...chatItems, ...cronItems];
      const bounded = hasMore ? body.filter((it) => it.at.getTime() >= boundary) : body;
      // Host alert bypasses the boundary filter (single item, first page only) so an
      // older-but-pending alert can't be sliced off.
      const items = [...hostItems, ...bounded].sort((a, b) => b.at.getTime() - a.at.getTime());
      const nextCursor = hasMore ? boundary : null;
      return { items, nextCursor };
    }),

  // Cheap counts for the sidebar bell badge + filter labels (no bodies). Polled
  // globally while the dashboard is open, so it stays bounded and select-light.
  counts: machineProcedure.query(async ({ ctx }) => {
    const machineId = ctx.machine.id;
    const [sessionRows, cron, hostStat] = await Promise.all([
      prisma.chatSession.findMany({
        where: { machineId },
        orderBy: { lastMessageAt: 'desc' },
        take: SESSION_SCAN,
        select: { id: true, lastMessageAt: true, lastReadAt: true },
      }),
      prisma.cronRun.count({ where: { cron: { machineId }, readAt: null, status: { not: 'running' } } }),
      prisma.hostStat.findUnique({ where: { machineId } }),
    ]);
    const chat = sessionRows.filter(isUnread).length;
    const host = hostAlertPending(hostStat) ? 1 : 0;
    return { chat, cron, total: chat + cron + host };
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
    return { ok: true, chat: chatRes.count, cron: cronRes.count };
  }),
});
