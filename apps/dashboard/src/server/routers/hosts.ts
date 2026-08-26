// hosts router — host-resource observability for the Host-health panel.
// Both procedures are machineProcedure (owner-only; scoped share keys rejected)
// and return data for the caller's authenticated machine.

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { watchdogConfigOf } from '@/lib/watchdog-config';
import { LIVE_SESSION } from '../session-cleanup';

export const hostsRouter = router({
  // Latest RAM/swap/load/cpu snapshot for this machine (null until the gateway's
  // host-stat tick has run once). The chip + panel derive health via lib/host-health,
  // with the machine's own thresholds (Settings → Watchdogs) riding along so the
  // client colors by the same lines the sync route alerts by.
  stat: machineProcedure.query(async ({ ctx }) => {
    const [stat, m] = await Promise.all([
      prisma.hostStat.findUnique({ where: { machineId: ctx.machine.id } }),
      prisma.machine.findUnique({ where: { id: ctx.machine.id }, select: { watchdogConfig: true } }),
    ]);
    return { stat, thresholds: watchdogConfigOf(m).hostRed };
  }),

  // Read (dismiss) a pending red-pressure alert from the notifications inbox —
  // stamps alertReadAt so the host item drops until the next red crossing.
  ackAlert: machineProcedure.mutation(async ({ ctx }) => {
    await prisma.hostStat.updateMany({
      where: { machineId: ctx.machine.id, redAlertAt: { not: null } },
      data: { alertReadAt: new Date() },
    });
    return { ok: true };
  }),

  // This machine's open chat sessions, heaviest first — the panel's "Top memory
  // sessions" list. Deliberately light (no message-preview subquery, unlike
  // chat.listSessions) since it polls alongside the panel. Archived sessions are
  // excluded (closedAt null): archiving now hibernates too, so an archived session
  // has no process left to account for.
  topSessions: machineProcedure.query(async ({ ctx }) => {
    return prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, closedAt: null, ...LIVE_SESSION },
      orderBy: [{ rssMb: { sort: 'desc', nulls: 'last' } }],
      take: 50,
      select: {
        id: true,
        agentName: true,
        title: true,
        rssMb: true,
        alive: true,
        state: true,
        lastMessageAt: true,
        hibernatedAt: true,
      },
    });
  }),
});
