// watchdogs router — the Settings → Watchdogs page's data source. One procedure
// returning everything six cards need: the effective config, each sweep's
// health, the host red-zone's current state, and the most recent alert each
// watchdog kind has raised (so "what did it last do" is visible without
// digging through logs).

import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { watchdogConfigOf } from '@/lib/watchdog-config';
import { hostHealth } from '@/lib/host-health';

const ALERT_KINDS = [
  'stuck-messages',
  'chrome-leak',
  'gateway-wedged',
  'high-load',
  'gateway-resurrected',
  'gateway-start-failed',
] as const;

export const watchdogsRouter = router({
  status: machineProcedure.query(async ({ ctx }) => {
    // Sweep liveness is NOT read from the sweeps' in-process health objects:
    // instrumentation (which starts the sweeps) and route handlers can hold
    // different module instances of the same file, so the route would report
    // a running sweep as stopped. Everything here is DB truth instead.
    const [machine, hostStat, alerts, stuckOpenCount, unansweredFlagged] = await Promise.all([
      prisma.machine.findUnique({
        where: { id: ctx.machine.id },
        select: { watchdogConfig: true },
      }),
      prisma.hostStat.findUnique({ where: { machineId: ctx.machine.id } }),
      prisma.machineAlert.findMany({
        where: { machineId: ctx.machine.id, kind: { in: [...ALERT_KINDS] } },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      prisma.machineAlert.count({
        where: {
          machineId: ctx.machine.id,
          kind: 'stuck-messages',
          resolvedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      }),
      prisma.chatSession.count({
        where: { machineId: ctx.machine.id, unansweredMsgId: { not: null }, unansweredAckedMsgId: null, trashedAt: null },
      }),
    ]);

    const config = watchdogConfigOf(machine);
    const lastAlertByKind: Record<
      string,
      { message: string; createdAt: Date; resolvedAt: Date | null; expiresAt: Date | null }
    > = {};
    for (const a of alerts) {
      if (lastAlertByKind[a.kind]) continue; // rows are newest-first
      lastAlertByKind[a.kind] = {
        message: a.message,
        createdAt: a.createdAt,
        resolvedAt: a.resolvedAt,
        expiresAt: a.expiresAt,
      };
    }

    return {
      config,
      stuckOpenCount,
      unansweredFlagged,
      host: {
        sampledAt: hostStat?.sampledAt ?? null,
        health: hostStat ? hostHealth(hostStat, config.hostRed) : null,
        redAlertAt: hostStat?.redAlertAt ?? null,
      },
      lastAlertByKind,
    };
  }),
});
