import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine, UsageInput } from '../route';

const Body = z.object({ items: z.array(UsageInput) });

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
  for (const u of body.items) {
    const hourBucket = new Date(u.hourBucket);
    await prisma.usageHourly.upsert({
      where: {
        machineId_agentName_hourBucket: {
          machineId: machine.id,
          agentName: u.agentName,
          hourBucket,
        },
      },
      create: {
        machineId: machine.id,
        agentName: u.agentName,
        hourBucket,
        cost: u.cost,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheCreationTokens: u.cacheCreationTokens ?? 0,
        cacheReadTokens: u.cacheReadTokens ?? 0,
        sessions: u.sessions ?? 0,
      },
      update: {
        cost: u.cost,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheCreationTokens: u.cacheCreationTokens ?? 0,
        cacheReadTokens: u.cacheReadTokens ?? 0,
        sessions: u.sessions ?? 0,
      },
    });
    updated++;
  }
  return NextResponse.json({ ok: true, updated });
}
