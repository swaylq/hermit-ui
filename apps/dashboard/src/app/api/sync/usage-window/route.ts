import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine } from '../route';

const Item = z.object({
  kind: z.enum(['fiveHour', 'weekly']),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  costUSD: z.number(),
  totalTokens: z.number().int().optional(),
  // The split behind the total — ~96% of it is cacheRead, which is what makes an
  // otherwise alarming token count legible. Optional: a gateway that hasn't been
  // updated yet just leaves them at 0.
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  cacheCreationTokens: z.number().int().optional(),
  cacheReadTokens: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
const Body = z.object({ items: z.array(Item) });

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = Body.parse(await req.json());
  let updated = 0;
  for (const w of body.items) {
    await prisma.usageWindow.upsert({
      where: { machineId_kind: { machineId: machine.id, kind: w.kind } },
      create: {
        machineId: machine.id,
        kind: w.kind,
        startTime: new Date(w.startTime),
        endTime: new Date(w.endTime),
        costUSD: w.costUSD,
        totalTokens: w.totalTokens ?? 0,
        inputTokens: w.inputTokens ?? 0,
        outputTokens: w.outputTokens ?? 0,
        cacheCreationTokens: w.cacheCreationTokens ?? 0,
        cacheReadTokens: w.cacheReadTokens ?? 0,
        isActive: w.isActive ?? false,
      },
      update: {
        startTime: new Date(w.startTime),
        endTime: new Date(w.endTime),
        costUSD: w.costUSD,
        totalTokens: w.totalTokens ?? 0,
        inputTokens: w.inputTokens ?? 0,
        outputTokens: w.outputTokens ?? 0,
        cacheCreationTokens: w.cacheCreationTokens ?? 0,
        cacheReadTokens: w.cacheReadTokens ?? 0,
        isActive: w.isActive ?? false,
      },
    });
    updated++;
  }
  return NextResponse.json({ ok: true, updated });
}
