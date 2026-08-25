// POST /api/sync/kimi-usage — the gateway pushes what is left of this machine's
// Kimi Code subscription, read from Moonshot's own `GET /v1/usages` with the
// credential's API key (the endpoint the Kimi CLI's `/usage` command calls).
//
// One row per machine, upserted. A third vendor and a third shape: Kimi reports
// a 7-day subscription quota AND a rolling rate window as separate rows with
// their own reset clocks, plus a concurrency cap — none of which has anywhere
// to live on PlanUsage's or CodexUsage's columns.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine, KimiUsageInput } from '../route';
import { Prisma } from '@/generated/prisma/client';

const Body = z.object({ kimiUsage: KimiUsageInput });

/**
 * A vendor timestamp, or null.
 *
 * `new Date('nonsense')` is an Invalid Date, and Prisma throws on one — which
 * would turn a malformed reset time into a 500 and freeze the whole panel
 * rather than dropping one field.
 */
function parsedDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  const k = body.kimiUsage;
  const data = {
    credentialId: k.credentialId,
    planLevel: k.planLevel ?? null,
    planName: k.planName ?? null,
    periodUsed: k.periodUsed ?? null,
    periodLimit: k.periodLimit ?? null,
    periodResetsAt: parsedDate(k.periodResetsAt),
    windows: (k.windows ?? []) as unknown as Prisma.InputJsonValue,
    parallelLimit: k.parallelLimit ?? null,
    extraBalanceCents: k.extraBalanceCents ?? null,
    extraCurrency: k.extraCurrency ?? null,
    capturedAt: parsedDate(k.capturedAt) ?? new Date(),
  };
  await prisma.kimiUsage.upsert({
    where: { machineId: machine.id },
    create: { machineId: machine.id, ...data },
    update: data,
  });
  return NextResponse.json({ ok: true });
}
