// sessionGroups router — the sidebar's collapsible drawers.
//
// A group is just a name and an order; the interesting property is what it does to
// the recents list. The list is recency-ordered, which is the right default for
// resuming work and falls apart at 70 open sessions — especially once cron mailboxes
// started bumping themselves to the top on every report. Filing a session into a
// group takes it OUT of the flat list, so the list goes back to being what it's good
// at: the handful of things you're actually working on.
//
// machineProcedure throughout: groups are a property of the machine's own sidebar, so
// a scoped agent-share key has no business reading or reshaping it.

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { LIVE_SESSION } from '../session-cleanup';

const Name = z.string().trim().min(1).max(40);

export const sessionGroupsRouter = router({
  // Groups with their live session counts. The sidebar polls this alongside
  // listSessions; counts come from one grouped query rather than N per-group ones.
  list: machineProcedure.query(async ({ ctx }) => {
    const groups = await prisma.sessionGroup.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    if (groups.length === 0) return [];
    const counts = await prisma.chatSession.groupBy({
      by: ['groupId'],
      where: { machineId: ctx.machine.id, closedAt: null, groupId: { not: null }, ...LIVE_SESSION },
      _count: { _all: true },
    });
    const byId = new Map(counts.map((c) => [c.groupId, c._count._all]));
    return groups.map((g) => ({ ...g, sessionCount: byId.get(g.id) ?? 0 }));
  }),

  create: machineProcedure.input(z.object({ name: Name })).mutation(async ({ ctx, input }) => {
    // New drawers go to the end. sortOrder is dense enough for a hand-managed list;
    // reordering is a later problem and doesn't need a fractional index yet.
    const last = await prisma.sessionGroup.findFirst({
      where: { machineId: ctx.machine.id },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return prisma.sessionGroup.create({
      data: { machineId: ctx.machine.id, name: input.name, sortOrder: (last?.sortOrder ?? 0) + 1 },
    });
  }),

  rename: machineProcedure
    .input(z.object({ id: z.string(), name: Name }))
    .mutation(async ({ ctx, input }) => {
      const r = await prisma.sessionGroup.updateMany({
        where: { id: input.id, machineId: ctx.machine.id },
        data: { name: input.name },
      });
      return { ok: r.count > 0 };
    }),

  // Deleting a drawer empties it; the sessions fall back into the recents list. The
  // FK is ON DELETE SET NULL so this can't take conversations with it.
  remove: machineProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const r = await prisma.sessionGroup.deleteMany({ where: { id: input.id, machineId: ctx.machine.id } });
    return { ok: r.count > 0 };
  }),

  setCollapsed: machineProcedure
    .input(z.object({ id: z.string(), collapsed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const r = await prisma.sessionGroup.updateMany({
        where: { id: input.id, machineId: ctx.machine.id },
        data: { collapsed: input.collapsed },
      });
      return { ok: r.count > 0 };
    }),

  /** File a session into a drawer, or pass null to send it back to the recents. */
  assign: machineProcedure
    .input(z.object({ sessionId: z.string(), groupId: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (input.groupId) {
        const g = await prisma.sessionGroup.findFirst({
          where: { id: input.groupId, machineId: ctx.machine.id },
          select: { id: true },
        });
        if (!g) throw new Error('group not found');
      }
      const r = await prisma.chatSession.updateMany({
        where: { id: input.sessionId, machineId: ctx.machine.id },
        data: { groupId: input.groupId },
      });
      return { ok: r.count > 0 };
    }),
});
