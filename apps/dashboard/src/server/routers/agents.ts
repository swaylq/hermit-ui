import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

// Dashboard reads agent state purely from postgres. The Mac-side gateway
// pushes /api/sync/agents on its 30s tick and /api/sync/agent-snapshot on
// its 60s tick — there is NO filesystem activity on the VPS triggered by
// any tRPC call here. The /agents detail sheet's lastUserPrompt /
// lastAssistantText come straight out of the Agent row.

export const agentsRouter = router({
  list: machineProcedure.query(async ({ ctx }) => {
    return prisma.agent.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: { name: 'asc' },
    });
  }),

  // Mark an agent for restart. Gateway picks this up on its next agents
  // tick (~30s) and runs restart.sh; restartStartedAt → done state when the
  // freshly written agent.pid replaces this row's pid via the normal sync.
  requestRestart: machineProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const row = await prisma.agent.update({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        data: { restartRequestedAt: new Date(), restartStartedAt: null },
        select: { name: true, restartRequestedAt: true },
      });
      return row;
    }),

  // Gateway poll endpoint: returns agents with a pending restart request.
  pendingActions: machineProcedure.query(async ({ ctx }) => {
    return prisma.agent.findMany({
      where: { machineId: ctx.machine.id, restartRequestedAt: { not: null }, restartStartedAt: null },
      select: { id: true, name: true, pid: true, restartRequestedAt: true },
    });
  }),

  // Gateway reports it has begun (so other gateways / re-polls don't fire it
  // again) and later clears once restart.sh has been kicked off.
  ackAction: machineProcedure
    .input(z.object({ id: z.string(), state: z.enum(['started', 'done', 'failed']) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.agent.findUnique({ where: { id: input.id } });
      if (!existing || existing.machineId !== ctx.machine.id) throw new Error('not found');
      if (input.state === 'started') {
        await prisma.agent.update({ where: { id: input.id }, data: { restartStartedAt: new Date() } });
      } else {
        await prisma.agent.update({
          where: { id: input.id },
          data: { restartRequestedAt: null, restartStartedAt: null },
        });
      }
      return { ok: true };
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

      // Pre-aggregated by the gateway's snapshot tick; freshness ≤ 60s.
      return {
        agent,
        events,
        lastUserPrompt: agent.lastUserPrompt,
        lastAssistantText: agent.lastAssistantText,
      };
    }),
});
