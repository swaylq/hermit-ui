// Notifications inbox — one aggregated, time-sorted feed of everything unread
// across ALL of the machine's agents: chat sessions (lastMessageAt > lastReadAt)
// and finished cron runs not yet read (readAt null, status != 'running'). It does
// NOT introduce its own read-state — it reads/writes the very same ChatSession
// .lastReadAt and CronRun.readAt that the chat sidebar and /cron page use, so a
// "read" here clears the red dot everywhere and vice-versa.
//
// Owner-only: every procedure is machineProcedure, which rejects scoped share
// keys — a shared single-agent link never sees the global inbox.

import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

// Unread = lastMessageAt > lastReadAt — a column-to-column comparison Prisma can't
// express in a `where`, so (exactly like isSessionUnread on the client) we pull the
// most-recent sessions and filter in JS. Unread sessions are by definition recently
// active, so a generous recent-window scan captures them without an unbounded fetch.
const SESSION_SCAN = 300;
const PREVIEW_LEN = 140;
const CRON_FEED_TAKE = 200;

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
  // The full feed: unread chat sessions + unread cron runs, merged newest-first.
  feed: machineProcedure.query(async ({ ctx }) => {
    const machineId = ctx.machine.id;
    const [sessionRows, cronRuns] = await Promise.all([
      prisma.chatSession.findMany({
        where: { machineId },
        orderBy: { lastMessageAt: 'desc' },
        take: SESSION_SCAN,
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
        where: { cron: { machineId }, readAt: null, status: { not: 'running' } },
        orderBy: { firedAt: 'desc' },
        take: CRON_FEED_TAKE,
        select: {
          id: true,
          firedAt: true,
          status: true,
          output: true,
          cron: { select: { id: true, title: true, prompt: true, agentName: true } },
        },
      }),
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

    const items = [...chatItems, ...cronItems].sort((a, b) => b.at.getTime() - a.at.getTime());
    return { items, counts: { chat: chatItems.length, cron: cronItems.length, total: items.length } };
  }),

  // Cheap counts for the sidebar bell badge + filter labels (no bodies). Polled
  // globally while the dashboard is open, so it stays bounded and select-light.
  counts: machineProcedure.query(async ({ ctx }) => {
    const machineId = ctx.machine.id;
    const [sessionRows, cron] = await Promise.all([
      prisma.chatSession.findMany({
        where: { machineId },
        orderBy: { lastMessageAt: 'desc' },
        take: SESSION_SCAN,
        select: { id: true, lastMessageAt: true, lastReadAt: true },
      }),
      prisma.cronRun.count({ where: { cron: { machineId }, readAt: null, status: { not: 'running' } } }),
    ]);
    const chat = sessionRows.filter(isUnread).length;
    return { chat, cron, total: chat + cron };
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
    return { ok: true, chat: chatRes.count, cron: cronRes.count };
  }),
});
