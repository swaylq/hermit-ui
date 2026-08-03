// All usage views are DB-backed — the gateway pushes UsageHourly + UsageWindow
// rows on a ~30 min cadence (apps/gateway/src/index.ts). No live shell-out to
// `ccusage` on dashboard request: the live path scanned every JSONL on disk
// and made every page render a multi-second wait. Polling client-side at the
// dashboard is fine since the DB rows only churn every 30 minutes.

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { getUsageFromDb, getUsageByDay, getUsageByWeek } from '../collect/usage-db';

export const usageRouter = router({
  list: machineProcedure.query(async ({ ctx }) => getUsageFromDb(ctx.machine.id)),
  // By day — the resolution the underlying rows actually have (see getUsageByDay).
  byDay: machineProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(14) }).default({ days: 14 }))
    .query(async ({ ctx, input }) => getUsageByDay(ctx.machine.id, input.days)),
  byWeek: machineProcedure
    .input(z.object({ weeks: z.number().int().min(1).max(52).default(12) }).default({ weeks: 12 }))
    .query(async ({ ctx, input }) => getUsageByWeek(ctx.machine.id, input.weeks)),

  windows: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.usageWindow.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: { kind: 'asc' },
    });
    // The token columns are BigInt (INT8) in the DB but always < 2^53 — hand the
    // client plain numbers so the wire type stays stable and no BigInt reaches the UI.
    return rows.map((r) => ({
      ...r,
      totalTokens: Number(r.totalTokens),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cacheCreationTokens: Number(r.cacheCreationTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
    }));
  }),

  // Real Claude Max plan consumption (5h session % + weekly %), scraped from
  // `claude /usage` by the gateway. The accurate counterpart to the ccusage
  // cost estimates above — this is what matches the CLI's /usage panel.
  planUsage: machineProcedure.query(async ({ ctx }) => {
    return prisma.planUsage.findUnique({ where: { machineId: ctx.machine.id } });
  }),
});
