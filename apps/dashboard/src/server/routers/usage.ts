// All usage views are DB-backed — the gateway pushes UsageHourly + UsageWindow
// rows on a ~30 min cadence (apps/gateway/src/index.ts). No live shell-out to
// `ccusage` on dashboard request: the live path scanned every JSONL on disk
// and made every page render a multi-second wait. Polling client-side at the
// dashboard is fine since the DB rows only churn every 30 minutes.

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { getUsageFromDb, getUsageByHour, getUsageByWeek } from '../collect/usage-db';

export const usageRouter = router({
  list: machineProcedure.query(async ({ ctx }) => getUsageFromDb(ctx.machine.id)),
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

  // Real Claude Max plan consumption (5h session % + weekly %), scraped from
  // `claude /usage` by the gateway. The accurate counterpart to the ccusage
  // cost estimates above — this is what matches the CLI's /usage panel.
  planUsage: machineProcedure.query(async ({ ctx }) => {
    return prisma.planUsage.findUnique({ where: { machineId: ctx.machine.id } });
  }),
});
