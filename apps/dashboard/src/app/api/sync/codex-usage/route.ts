// POST /api/sync/codex-usage — the gateway pushes Codex's live app-server quota
// snapshot plus legacy per-day token activity from rollout files.
//
// New columns are optional during rollout: an older gateway must not erase a
// newer gateway's last good 5h/weekly reading by omitting fields it does not know.

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
  const baseData = {
    usedPercent: c.usedPercent ?? null,
    windowMinutes: c.windowMinutes ?? null,
    resetsAt: c.resetsAt ? new Date(c.resetsAt) : null,
    planType: c.planType ?? null,
    daily: (c.daily ?? []) as unknown as Prisma.InputJsonValue,
    capturedAt: c.capturedAt ? new Date(c.capturedAt) : new Date(),
  };
  const newData = {
    fiveHourPct: c.fiveHourPct ?? null,
    fiveHourResetsAt: c.fiveHourResetsAt ? new Date(c.fiveHourResetsAt) : null,
    fiveHourLimitId: c.fiveHourLimitId ?? null,
    fiveHourLimitName: c.fiveHourLimitName ?? null,
    weekPct: c.weekPct ?? null,
    weekResetsAt: c.weekResetsAt ? new Date(c.weekResetsAt) : null,
    weekLimitId: c.weekLimitId ?? null,
    weekLimitName: c.weekLimitName ?? null,
  };
  const update = {
    ...baseData,
    ...(c.fiveHourPct !== undefined ? { fiveHourPct: newData.fiveHourPct } : {}),
    ...(c.fiveHourResetsAt !== undefined ? { fiveHourResetsAt: newData.fiveHourResetsAt } : {}),
    ...(c.fiveHourLimitId !== undefined ? { fiveHourLimitId: newData.fiveHourLimitId } : {}),
    ...(c.fiveHourLimitName !== undefined ? { fiveHourLimitName: newData.fiveHourLimitName } : {}),
    ...(c.weekPct !== undefined ? { weekPct: newData.weekPct } : {}),
    ...(c.weekResetsAt !== undefined ? { weekResetsAt: newData.weekResetsAt } : {}),
    ...(c.weekLimitId !== undefined ? { weekLimitId: newData.weekLimitId } : {}),
    ...(c.weekLimitName !== undefined ? { weekLimitName: newData.weekLimitName } : {}),
  };
  await prisma.codexUsage.upsert({
    where: { machineId: machine.id },
    create: { machineId: machine.id, ...baseData, ...newData },
    update,
  });
  return NextResponse.json({ ok: true });
}
