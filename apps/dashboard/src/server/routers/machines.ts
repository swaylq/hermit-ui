import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

export const machinesRouter = router({
  me: machineProcedure.query(async ({ ctx }) => ({
    id: ctx.machine.id,
    name: ctx.machine.name,
    alias: ctx.machine.alias,
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

  // Server-side display alias for this machine — shown in the dashboard's
  // workspace switcher (falls back to `name` when null). Blank clears it.
  setAlias: machineProcedure
    .input(z.object({ alias: z.string().trim().max(40).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const alias = input.alias && input.alias.length > 0 ? input.alias : null;
      await prisma.machine.update({ where: { id: ctx.machine.id }, data: { alias } });
      return { alias };
    }),

  // ── Operations panel ────────────────────────────────────────────────────────
  // Machine-level ops the gateway runs on its host. The dashboard can't touch the
  // host, so it queues a MachineRequest; the gateway polls, executes, writes the
  // result back. Re-queuing while one is pending/running collapses to the same row.
  requestUpgradeClaude: machineProcedure.mutation(async ({ ctx }) => {
    const existing = await prisma.machineRequest.findFirst({
      where: { machineId: ctx.machine.id, kind: 'upgrade-claude', status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    if (existing) return { ok: true, id: existing.id, alreadyQueued: true };
    const r = await prisma.machineRequest.create({
      data: { machineId: ctx.machine.id, kind: 'upgrade-claude' },
      select: { id: true },
    });
    return { ok: true, id: r.id, alreadyQueued: false };
  }),

  requestRestartAllSessions: machineProcedure.mutation(async ({ ctx }) => {
    const existing = await prisma.machineRequest.findFirst({
      where: { machineId: ctx.machine.id, kind: 'restart-all-sessions', status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    if (existing) return { ok: true, id: existing.id, alreadyQueued: true };
    const r = await prisma.machineRequest.create({
      data: { machineId: ctx.machine.id, kind: 'restart-all-sessions' },
      select: { id: true },
    });
    return { ok: true, id: r.id, alreadyQueued: false };
  }),

  // Latest request per kind — drives the panel's status/output. Polled while a
  // request is in flight so "running…" → "done" updates without a refresh.
  opsStatus: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.machineRequest.findMany({
      where: { machineId: ctx.machine.id, kind: { in: ['upgrade-claude', 'restart-all-sessions'] } },
      orderBy: { requestedAt: 'desc' },
      take: 10,
      select: { id: true, kind: true, status: true, output: true, error: true, requestedAt: true, resolvedAt: true },
    });
    return {
      upgrade: rows.find((r) => r.kind === 'upgrade-claude') ?? null,
      restartAll: rows.find((r) => r.kind === 'restart-all-sessions') ?? null,
    };
  }),

  // ── Gateway endpoints ───────────────────────────────────────────────────────
  pollRequests: machineProcedure.query(async ({ ctx }) => {
    return prisma.machineRequest.findMany({
      where: { machineId: ctx.machine.id, status: 'pending' },
      orderBy: { requestedAt: 'asc' },
      select: { id: true, kind: true },
    });
  }),

  ackRequest: machineProcedure
    .input(
      z.object({
        id: z.string(),
        status: z.enum(['running', 'done', 'error']),
        output: z.string().optional(),
        error: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await prisma.machineRequest.updateMany({
        where: { id: input.id, machineId: ctx.machine.id },
        data: {
          status: input.status,
          ...(input.output !== undefined ? { output: input.output.slice(0, 8000) } : {}),
          ...(input.error !== undefined ? { error: input.error.slice(0, 2000) } : {}),
          ...(input.status === 'done' || input.status === 'error' ? { resolvedAt: new Date() } : {}),
        },
      });
      return { ok: true };
    }),
});
