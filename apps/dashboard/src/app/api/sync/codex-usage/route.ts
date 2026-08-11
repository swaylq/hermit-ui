// POST /api/sync/codex-usage — the gateway pushes what codex has spent on this
// machine, read from codex's own rollout files (its `token_count` events carry
// both a running token total and the server's `rate_limits` block).
//
// One row per machine, upserted. Kept separate from PlanUsage because that row
// is Claude's two-window shape scraped from `claude /usage`; codex reports one
// window with its own meaning and reset clock, and sharing a row would mean
// nullable columns whose meaning depends on which vendor wrote last.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine, CodexUsageInput } from '../route';
import { Prisma } from '@/generated/prisma/client';

const Body = z.object({ codexUsage: CodexUsageInput });

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  const c = body.codexUsage;
  const data = {
    usedPercent: c.usedPercent ?? null,
    windowMinutes: c.windowMinutes ?? null,
    resetsAt: c.resetsAt ? new Date(c.resetsAt) : null,
    planType: c.planType ?? null,
    daily: (c.daily ?? []) as unknown as Prisma.InputJsonValue,
    capturedAt: c.capturedAt ? new Date(c.capturedAt) : new Date(),
  };
  await prisma.codexUsage.upsert({
    where: { machineId: machine.id },
    create: { machineId: machine.id, ...data },
    update: data,
  });
  return NextResponse.json({ ok: true });
}
