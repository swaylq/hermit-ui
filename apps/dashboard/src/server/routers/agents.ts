import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

// Dashboard reads agent state purely from postgres. The Mac-side gateway
// pushes:
//   /api/sync/agents          — static folder metadata (markdowns + skills)
//   /api/sync/session-snapshot — per-session runtime (pid/alive/ctx/etc.)
// There is NO filesystem activity on the VPS triggered by any tRPC call.
//
// Agent has no runtime concept anymore — runtime lives on ChatSession.
// Restart is per-session (chat.requestSessionRestart). Per-agent restart
// is gone.

export const agentsRouter = router({
  list: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.agent.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        directory: true,
        skillNames: true,
        metadataAt: true,
      },
    });
    if (rows.length === 0) return [];

    // Sessions count + active-sessions count per agent (one grouped query).
    const counts = await prisma.chatSession.groupBy({
      by: ['agentName', 'alive'],
      where: { machineId: ctx.machine.id, agentName: { in: rows.map((r) => r.name) } },
      _count: { _all: true },
    });
    const sessionCount = new Map<string, number>();
    const activeCount = new Map<string, number>();
    for (const c of counts) {
      sessionCount.set(c.agentName, (sessionCount.get(c.agentName) ?? 0) + c._count._all);
      if (c.alive) activeCount.set(c.agentName, (activeCount.get(c.agentName) ?? 0) + c._count._all);
    }
    return rows.map((r) => ({
      ...r,
      sessionCount: sessionCount.get(r.name) ?? 0,
      activeSessionCount: activeCount.get(r.name) ?? 0,
    }));
  }),

  byName: machineProcedure
    .input(z.object({ name: z.string() }))
    .query(async ({ ctx, input }) => {
      const agent = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
      });
      if (!agent) return null;
      const events = await prisma.event.findMany({
        where: { machineId: ctx.machine.id, agentName: input.name },
        orderBy: { ts: 'desc' },
        take: 30,
      });
      // Sessions are queried separately by the detail sheet via
      // chat.listSessions({ agentName }), so no need to join here.
      return { agent, events };
    }),
});
