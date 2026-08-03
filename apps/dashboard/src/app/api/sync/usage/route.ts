import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine, UsageInput } from '../route';

// `replaceSince` makes this batch a SNAPSHOT of the window rather than an addition to
// it: every bucket from that instant on is dropped first, and this run's rows become
// the window's truth. Without it the table accumulated the same money over and over —
// a `ccusage session` row carries a session's LIFETIME total against its LAST-activity
// date, so a session still in use refiles its whole running total onto each new day,
// and an upsert-only writer keeps every earlier day's copy of it. That read as $27.4k
// for one agent over 30 days against $3.7k of real session totals (2026-07-31).
const Body = z.object({ items: z.array(UsageInput), replaceSince: z.string().datetime().optional() });

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  const row = (u: z.infer<typeof UsageInput>) => ({
    machineId: machine.id,
    agentName: u.agentName,
    hourBucket: new Date(u.hourBucket),
    cost: u.cost,
    costExCacheRead: u.costExCacheRead ?? u.cost,
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheCreationTokens: u.cacheCreationTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    sessions: u.sessions ?? 0,
  });

  // Clear-then-write in ONE transaction: a reader mid-run must see either the old
  // window or the new one, never an empty page. Only the first batch of a run carries
  // the boundary; the rest fall through to the upsert below and fill in behind it.
  if (body.replaceSince) {
    const since = new Date(body.replaceSince);
    const rows = body.items.map(row);
    await prisma.$transaction([
      prisma.usageHourly.deleteMany({ where: { machineId: machine.id, hourBucket: { gte: since } } }),
      ...(rows.length ? [prisma.usageHourly.createMany({ data: rows })] : []),
    ]);
    return NextResponse.json({ ok: true, updated: rows.length, replacedFrom: since.toISOString() });
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
        costExCacheRead: u.costExCacheRead ?? u.cost,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheCreationTokens: u.cacheCreationTokens ?? 0,
        cacheReadTokens: u.cacheReadTokens ?? 0,
        sessions: u.sessions ?? 0,
      },
      update: {
        cost: u.cost,
        costExCacheRead: u.costExCacheRead ?? u.cost,
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
