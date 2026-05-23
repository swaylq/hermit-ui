import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

function sh(cmd: string, timeoutMs = 3000) {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: timeoutMs });
  return (r.stdout ?? '').trim();
}

// Dashboard reads agent state purely from postgres — the gateway pushes via
// /api/sync/agents on its 30s tick. Browser opening /agents triggers ZERO
// filesystem activity on the VPS. The shell-grep snippets in byName below
// are the last remaining FS-touching path; M4.3 lifts those into DB columns
// the gateway pre-aggregates.

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

      // Best-effort: last user/assistant snippet from JSONL.
      let lastUserPrompt: string | null = null;
      let lastAssistantText: string | null = null;
      if (agent.transcriptPath) {
        const userRaw = sh(
          `grep '"type":"user"' ${JSON.stringify(agent.transcriptPath)} | tail -1 | ` +
            `jq -r '.message.content // empty | if type == "array" then map(.text // "") | join(" ") else . end' 2>/dev/null`,
          1500,
        );
        if (userRaw) lastUserPrompt = userRaw.slice(0, 600);

        const assistRaw = sh(
          `grep '"type":"assistant"' ${JSON.stringify(agent.transcriptPath)} | tail -1 | ` +
            `jq -r '[.message.content[]? | select(.type=="text") | .text] | join(" ") // empty' 2>/dev/null`,
          1500,
        );
        if (assistRaw) lastAssistantText = assistRaw.slice(0, 600);
      }

      return { agent, events, lastUserPrompt, lastAssistantText };
    }),
});
