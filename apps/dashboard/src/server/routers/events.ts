import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

const PUSH_INPUT = z.object({
  agent: z.string().min(1).max(64),
  message: z.string().min(1).max(8000),
  type: z.string().min(1).max(32).default('note'),
  title: z.string().max(120).optional(),
});

export const eventsRouter = router({
  list: machineProcedure
    .input(
      z
        .object({
          agent: z.string().optional(),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .default({ limit: 100 }),
    )
    .query(async ({ ctx, input }) => {
      return prisma.event.findMany({
        where: {
          machineId: ctx.machine.id,
          ...(input.agent ? { agentName: input.agent } : {}),
        },
        orderBy: { ts: 'desc' },
        take: input.limit,
      });
    }),

  push: machineProcedure.input(PUSH_INPUT).mutation(async ({ ctx, input }) => {
    const agent = await prisma.agent.findUnique({
      where: { machineId_name: { machineId: ctx.machine.id, name: input.agent } },
    });
    return prisma.event.create({
      data: {
        machineId: ctx.machine.id,
        agentId: agent?.id ?? null,
        agentName: input.agent,
        type: input.type,
        title: input.title ?? null,
        message: input.message,
      },
    });
  }),
});

export type PushInput = z.infer<typeof PUSH_INPUT>;
