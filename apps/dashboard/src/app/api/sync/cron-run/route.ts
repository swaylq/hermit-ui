// Gateway posts cron execution state here. Two phases:
//   start  → create a CronRun(running), stamp the Cron's lastFire + nextFire,
//            return { runId } so the gateway can close it on finish.
//   finish → close the CronRun with status/output/duration, flip lastStatus.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine } from '../route';

const StartInput = z.object({
  phase: z.literal('start'),
  cronId: z.string(),
  firedAt: z.string().datetime(),
  nextFire: z.string().datetime(),
});

const FinishInput = z.object({
  phase: z.literal('finish'),
  cronId: z.string(),
  runId: z.string().nullable().optional(),
  status: z.string(),
  output: z.string().optional(),
  durationMs: z.number().int().optional(),
});

const Body = z.discriminatedUnion('phase', [StartInput, FinishInput]);

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  const cron = await prisma.cron.findUnique({ where: { id: body.cronId } });
  if (!cron || cron.machineId !== machine.id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  if (body.phase === 'start') {
    const run = await prisma.cronRun.create({
      data: { cronId: body.cronId, firedAt: new Date(body.firedAt), status: 'running' },
    });
    await prisma.cron.update({
      where: { id: body.cronId },
      data: {
        lastFire: new Date(body.firedAt),
        nextFire: new Date(body.nextFire),
        lastStatus: 'running',
      },
    });
    return NextResponse.json({ runId: run.id });
  }

  // finish
  if (body.runId) {
    await prisma.cronRun.update({
      where: { id: body.runId },
      data: {
        status: body.status,
        output: body.output ?? null,
        durationMs: body.durationMs ?? null,
        finishedAt: new Date(),
      },
    });
  }
  await prisma.cron.update({ where: { id: body.cronId }, data: { lastStatus: body.status } });
  return NextResponse.json({ ok: true });
}
