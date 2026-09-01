// Gateway posts cron execution state here. Two phases:
//   start  → create a CronRun(running), stamp the Cron's lastFire + nextFire,
//            return { runId } so the gateway can close it on finish.
//   finish → close the CronRun with status/output/duration, flip lastStatus, and
//            apply whatever the run said about its OWN schedule (see FinishInput).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine } from '../route';
import { finishCronRun } from '@/server/cron-finish';

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
  // ── What the run said about its own schedule ──
  // Both are markers the run printed on its last line and the gateway stripped out
  // of the report before posting it here (parseRunMarkers in cron-runner.ts). This
  // is what replaced the session-scoped loop: iterate-until-done and pick-your-own
  // -cadence now belong to a durable cron. Absent on an ordinary run, so a cron that
  // never signals anything posts exactly the payload it always did.
  //
  // CRON_DONE — the run reached the goal it was created for and wants no more fires.
  done: z.boolean().optional(),
  // CRON_NEXT <minutes> — re-pace: fire again after this many seconds from now
  // instead of the stored interval. The gateway already refuses out-of-range values;
  // validated again here because this is an HTTP endpoint, not a gateway-only call,
  // and a 1-second interval written straight into the row is a runaway.
  nextIntervalSec: z.number().int().min(60).max(604_800).optional(),
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

  // finish. Every effect of closing a run lives in finishCronRun so the sweep that
  // rescues an ABANDONED run (server/cron-sweep.ts) goes down the identical path —
  // see the note at the top of that module.
  await finishCronRun({
    machineId: machine.id,
    cron,
    runId: body.runId ?? null,
    status: body.status,
    output: body.output,
    durationMs: body.durationMs,
    done: body.done,
    nextIntervalSec: body.nextIntervalSec,
  });
  return NextResponse.json({ ok: true });
}
