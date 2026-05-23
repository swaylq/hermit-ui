import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine, LaunchAgentInput } from '../route';

const Body = z.object({ items: z.array(LaunchAgentInput) });

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  let updated = 0;
  for (const t of body.items) {
    await prisma.launchAgentRecord.upsert({
      where: { machineId_label: { machineId: machine.id, label: t.label } },
      create: {
        machineId: machine.id,
        label: t.label,
        scheduleKind: t.scheduleKind ?? null,
        intervalSec: t.intervalSec ?? null,
        calendarHour: t.calendarHour ?? null,
        calendarMinute: t.calendarMinute ?? null,
        runAtLoad: t.runAtLoad ?? false,
        keepAlive: t.keepAlive ?? false,
        running: t.running ?? null,
        logPath: t.logPath ?? null,
        lastFire: t.lastFire ? new Date(t.lastFire) : null,
        programArgs: t.programArgs ?? [],
      },
      update: {
        scheduleKind: t.scheduleKind ?? null,
        intervalSec: t.intervalSec ?? null,
        calendarHour: t.calendarHour ?? null,
        calendarMinute: t.calendarMinute ?? null,
        runAtLoad: t.runAtLoad ?? false,
        keepAlive: t.keepAlive ?? false,
        running: t.running ?? null,
        logPath: t.logPath ?? null,
        lastFire: t.lastFire ? new Date(t.lastFire) : null,
        programArgs: t.programArgs ?? [],
      },
    });
    updated++;
  }

  // Drop stale rows the gateway no longer reports (the inventory shrunk).
  const labels = body.items.map((i) => i.label);
  await prisma.launchAgentRecord.deleteMany({
    where: { machineId: machine.id, label: { notIn: labels } },
  });

  return NextResponse.json({ ok: true, updated });
}
