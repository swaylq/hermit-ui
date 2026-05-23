import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine, TaskResultInput } from '../route';

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof TaskResultInput>;
  try {
    body = TaskResultInput.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  const existing = await prisma.systemTask.findUnique({ where: { id: body.id } });
  if (!existing || existing.machineId !== machine.id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  await prisma.systemTask.update({
    where: { id: body.id },
    data: {
      lastStatus: body.status,
      lastOutput: body.output ?? null,
      lastDurationMs: body.durationMs ?? null,
      happySessionId: body.happySessionId ?? existing.happySessionId,
      lastFire: body.lastFire ? new Date(body.lastFire) : existing.lastFire,
    },
  });
  return NextResponse.json({ ok: true });
}
