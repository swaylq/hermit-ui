import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { getUsage } from '../collect/usage';
import { getUsageFromDb, getUsageByHour, getUsageByWeek } from '../collect/usage-db';

const GATEWAY_DRIVEN = process.env.GATEWAY_DRIVEN === '1';

export const usageRouter = router({
  list: machineProcedure.query(async ({ ctx }) => {
    return GATEWAY_DRIVEN ? getUsageFromDb(ctx.machine.id) : getUsage();
  }),
  byHour: machineProcedure
    .input(z.object({ hours: z.number().int().min(1).max(168).default(48) }).default({ hours: 48 }))
    .query(async ({ ctx, input }) => getUsageByHour(ctx.machine.id, input.hours)),
  byWeek: machineProcedure
    .input(z.object({ weeks: z.number().int().min(1).max(52).default(12) }).default({ weeks: 12 }))
    .query(async ({ ctx, input }) => getUsageByWeek(ctx.machine.id, input.weeks)),

  windows: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.usageWindow.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: { kind: 'asc' },
    });
    return rows;
  }),
});
