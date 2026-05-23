import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

export const machinesRouter = router({
  me: machineProcedure.query(async ({ ctx }) => ({
    id: ctx.machine.id,
    name: ctx.machine.name,
    hostname: ctx.machine.hostname,
    keyPrefix: ctx.machine.keyPrefix,
    createdAt: ctx.machine.createdAt,
    lastSeen: ctx.machine.lastSeen,
    fiveHourLimitUsd: ctx.machine.fiveHourLimitUsd,
    weeklyLimitUsd: ctx.machine.weeklyLimitUsd,
  })),

  setLimits: machineProcedure
    .input(
      z.object({
        fiveHourLimitUsd: z.number().nullable().optional(),
        weeklyLimitUsd: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return prisma.machine.update({
        where: { id: ctx.machine.id },
        data: {
          ...(input.fiveHourLimitUsd !== undefined ? { fiveHourLimitUsd: input.fiveHourLimitUsd } : {}),
          ...(input.weeklyLimitUsd !== undefined ? { weeklyLimitUsd: input.weeklyLimitUsd } : {}),
        },
        select: { fiveHourLimitUsd: true, weeklyLimitUsd: true },
      });
    }),
});
