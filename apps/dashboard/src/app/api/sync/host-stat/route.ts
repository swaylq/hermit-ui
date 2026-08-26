// POST /api/sync/host-stat — gateway pushes this host's RAM/swap/load/cpu snapshot.
//
// One row per machine, upserted (latest only, no history). Drives the dashboard
// Host-health panel + the red-pressure notification. Health colour keys on
// free-RAM + load, NOT swap-used (macOS lazily reclaims swapfiles — incident §3).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { hostHealth } from '@/lib/host-health';
import { watchdogConfigOf } from '@/lib/watchdog-config';
import { resolveMachine } from '../route';
import { enqueuePush } from '@/server/push';
import { hostEvent } from '@/server/push/events';

const Stat = z.object({
  ramTotalMb: z.number().int().nullable().optional(),
  ramFreeMb: z.number().int().nullable().optional(),
  swapUsedMb: z.number().int().nullable().optional(),
  swapTotalMb: z.number().int().nullable().optional(),
  loadAvg1: z.number().nullable().optional(),
  cpuCount: z.number().int().nullable().optional(),
  chromeCount: z.number().int().nullable().optional(),
  chromeRssMb: z.number().int().nullable().optional(),
  transcriptTotalMb: z.number().int().nullable().optional(),
  transcriptCount: z.number().int().nullable().optional(),
  transcriptOrphanMb: z.number().int().nullable().optional(),
  transcriptOrphanCount: z.number().int().nullable().optional(),
});
const Body = z.object({ stat: Stat });

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  // Red-crossing detection: stamp redAlertAt only when health goes non-red → red
  // (so a sustained red doesn't re-alert every 30s); clear it on recovery. Leave
  // alertReadAt untouched here (only the inbox read mutations move it).
  // Thresholds + the on/off come from Settings → Watchdogs (Machine.watchdogConfig);
  // a switched-off red-zone still records stats, it just never stamps or pushes.
  const wd = watchdogConfigOf(
    await prisma.machine.findUnique({ where: { id: machine.id }, select: { watchdogConfig: true } }),
  ).hostRed;
  const prev = await prisma.hostStat.findUnique({ where: { machineId: machine.id } });
  const newHealth = hostHealth(body.stat, wd);
  const prevHealth = prev ? hostHealth(prev, wd) : 'green';
  let redAlertAt = prev?.redAlertAt ?? null;
  const crossedIntoRed = wd.enabled && newHealth === 'red' && prevHealth !== 'red';
  if (crossedIntoRed) redAlertAt = new Date();
  else if (newHealth !== 'red') redAlertAt = null;

  const data = { ...body.stat, sampledAt: new Date(), redAlertAt };
  await prisma.hostStat.upsert({
    where: { machineId: machine.id },
    create: { machineId: machine.id, ...data },
    update: data,
  });

  // Only on the CROSSING, matching redAlertAt's own semantics — this tick runs
  // every ~30s, and a machine can sit red for hours.
  if (crossedIntoRed) {
    enqueuePush(
      hostEvent({
        machineId: machine.id,
        machineName: machine.alias?.trim() || machine.name,
        ramFreeMb: body.stat.ramFreeMb,
        loadAvg1: body.stat.loadAvg1,
      }),
    );
  }
  return NextResponse.json({ ok: true });
}
