// POST /api/sync/agents — gateway pushes the static folder metadata for every
// agent under AGENTS_ROOT. Runtime state (pid/alive/ctx/etc.) lives on
// ChatSession and arrives via /api/sync/session-snapshot.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine, AgentInput } from '../route';

const Body = z.object({ agents: z.array(AgentInput) });

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
  const now = new Date();
  for (const a of body.agents) {
    const data = {
      directory: a.directory ?? null,
      identityText: a.identityText ?? null,
      userText: a.userText ?? null,
      agentsText: a.agentsText ?? null,
      toolsText: a.toolsText ?? null,
      evolutionLessons: a.evolutionLessons ?? null,
      skillNames: a.skillNames ?? [],
      memorySummary: a.memorySummary ?? null,
      metadataAt: now,
    };
    await prisma.agent.upsert({
      where: { machineId_name: { machineId: machine.id, name: a.name } },
      create: { machineId: machine.id, name: a.name, ...data },
      update: data,
    });
    updated++;
  }
  return NextResponse.json({ ok: true, updated });
}
