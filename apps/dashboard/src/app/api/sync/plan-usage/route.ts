// POST /api/sync/plan-usage — the gateway pushes the REAL Claude Max plan
// consumption it scraped from `claude /usage` (5h session % + weekly %). One row
// per machine, upserted. This is the accurate source; UsageWindow/UsageHourly
// are ccusage cost estimates.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine, PlanUsageInput } from '../route';

const Body = z.object({ planUsage: PlanUsageInput });

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  const p = body.planUsage;
  const data = {
    sessionPct: p.sessionPct ?? null,
    weekPct: p.weekPct ?? null,
    weekSonnetPct: p.weekSonnetPct ?? null,
    sessionResetText: p.sessionResetText ?? null,
    weekResetText: p.weekResetText ?? null,
    capturedAt: p.capturedAt ? new Date(p.capturedAt) : new Date(),
  };
  await prisma.planUsage.upsert({
    where: { machineId: machine.id },
    create: { machineId: machine.id, ...data },
    update: data,
  });
  return NextResponse.json({ ok: true });
}
