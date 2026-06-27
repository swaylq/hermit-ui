// POST /api/sync/host-stat — gateway pushes this host's RAM/swap/load/cpu snapshot.
//
// One row per machine, upserted (latest only, no history). Drives the dashboard
// Host-health panel + the red-pressure notification. Health colour keys on
// free-RAM + load, NOT swap-used (macOS lazily reclaims swapfiles — incident §3).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { hostHealth } from '@/lib/host-health';
import { resolveMachine } from '../route';

const Stat = z.object({
  ramTotalMb: z.number().int().nullable().optional(),
  ramFreeMb: z.number().int().nullable().optional(),
  swapUsedMb: z.number().int().nullable().optional(),
  swapTotalMb: z.number().int().nullable().optional(),
  loadAvg1: z.number().nullable().optional(),
  cpuCount: z.number().int().nullable().optional(),
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
  const prev = await prisma.hostStat.findUnique({ where: { machineId: machine.id } });
  const newHealth = hostHealth(body.stat);
  const prevHealth = prev ? hostHealth(prev) : 'green';
  let redAlertAt = prev?.redAlertAt ?? null;
  if (newHealth === 'red' && prevHealth !== 'red') redAlertAt = new Date();
  else if (newHealth !== 'red') redAlertAt = null;

  const data = { ...body.stat, sampledAt: new Date(), redAlertAt };
  await prisma.hostStat.upsert({
    where: { machineId: machine.id },
    create: { machineId: machine.id, ...data },
    update: data,
  });
  return NextResponse.json({ ok: true });
}
