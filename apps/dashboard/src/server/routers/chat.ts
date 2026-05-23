// Direct dashboard ↔ agent chat. Sessions live in DB; gateway tails
// `pendingMessages` (user rows without deliveredAt) every couple seconds,
// hands them to the Anthropic SDK, then POSTs assistant rows back via
// /api/sync/chat-message. Browser tails messages via tRPC refetch (1s).

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

const ContentBlock = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.any(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.any(),
    is_error: z.boolean().optional(),
  }),
  z.object({ type: z.literal('thinking'), thinking: z.string().optional() }),
  z.object({ type: z.string(), [Symbol.for('passthrough')]: z.any() }).passthrough(),
]);

export const chatRouter = router({
  listSessions: machineProcedure
    .input(z.object({ agentName: z.string().optional() }).default({}))
    .query(async ({ ctx, input }) => {
      return prisma.chatSession.findMany({
        where: {
          machineId: ctx.machine.id,
          ...(input.agentName ? { agentName: input.agentName } : {}),
        },
        orderBy: [{ closedAt: 'asc' }, { lastMessageAt: 'desc' }, { startedAt: 'desc' }],
        select: {
          id: true,
          agentName: true,
          title: true,
          claudeSessionId: true,
          startedAt: true,
          lastMessageAt: true,
          closedAt: true,
          _count: { select: { messages: true } },
        },
      });
    }),

  createSession: machineProcedure
    .input(z.object({ agentName: z.string().min(1).max(64), title: z.string().max(120).optional() }))
    .mutation(async ({ ctx, input }) => {
      return prisma.chatSession.create({
        data: { machineId: ctx.machine.id, agentName: input.agentName, title: input.title ?? null },
      });
    }),

  closeSession: machineProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      return prisma.chatSession.update({ where: { id: input.id }, data: { closedAt: new Date() } });
    }),

  reopenSession: machineProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      return prisma.chatSession.update({ where: { id: input.id }, data: { closedAt: null } });
    }),

  setTitle: machineProcedure
    .input(z.object({ id: z.string(), title: z.string().max(120) }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      return prisma.chatSession.update({ where: { id: input.id }, data: { title: input.title } });
    }),

  listMessages: machineProcedure
    .input(z.object({ sessionId: z.string(), limit: z.number().int().min(1).max(500).default(200) }))
    .query(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      return prisma.chatMessage.findMany({
        where: { sessionId: input.sessionId },
        orderBy: { createdAt: 'asc' },
        take: input.limit,
      });
    }),

  send: machineProcedure
    .input(z.object({ sessionId: z.string(), text: z.string().min(1).max(64_000) }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      if (s.closedAt) throw new Error('session is closed');
      const msg = await prisma.chatMessage.create({
        data: {
          sessionId: input.sessionId,
          role: 'user',
          content: [{ type: 'text', text: input.text }],
        },
      });
      // Clear any stale cancel signal from a previous turn so this new
      // turn isn't immediately killed by the gateway.
      await prisma.chatSession.update({
        where: { id: input.sessionId },
        data: { lastMessageAt: new Date(), cancelRequestedAt: null },
      });
      return msg;
    }),

  // User clicks Stop on the compose bar. Flips a flag the gateway polls; the
  // gateway then SIGTERMs the in-flight `claude --print` child and writes a
  // "[stopped by user]" system row before clearing the flag via ackCancel.
  cancelTurn: machineProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      await prisma.chatSession.update({
        where: { id: input.sessionId },
        data: { cancelRequestedAt: new Date() },
      });
      return { ok: true };
    }),

  // ─── Gateway endpoints ────────────────────────────────────────────────────
  // Active sessions + their unread user messages. Gateway polls this every 2s.
  pollPending: machineProcedure.query(async ({ ctx }) => {
    const sessions = await prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, closedAt: null },
      select: { id: true, agentName: true, claudeSessionId: true },
    });
    if (sessions.length === 0) return { sessions: [], messages: [] };
    const sessionIds = sessions.map((s) => s.id);
    const messages = await prisma.chatMessage.findMany({
      where: { sessionId: { in: sessionIds }, role: 'user', deliveredAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return { sessions, messages };
  }),

  ackDelivered: machineProcedure
    .input(z.object({ messageIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      if (input.messageIds.length === 0) return { ok: true, updated: 0 };
      const r = await prisma.chatMessage.updateMany({
        where: {
          id: { in: input.messageIds },
          session: { machineId: ctx.machine.id },
        },
        data: { deliveredAt: new Date() },
      });
      return { ok: true, updated: r.count };
    }),

  // Gateway polls this every ~1.5s during turns. Returns sessions where the
  // user has clicked Stop. Gateway kills the matching child + acks.
  pollCancellations: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, cancelRequestedAt: { not: null } },
      select: { id: true, cancelRequestedAt: true },
    });
    return rows;
  }),

  ackCancel: machineProcedure
    .input(z.object({ sessionIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      if (input.sessionIds.length === 0) return { ok: true, updated: 0 };
      const r = await prisma.chatSession.updateMany({
        where: { id: { in: input.sessionIds }, machineId: ctx.machine.id },
        data: { cancelRequestedAt: null },
      });
      return { ok: true, updated: r.count };
    }),
});
