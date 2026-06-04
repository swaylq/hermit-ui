// POST /api/sync/agents — gateway pushes content (markdowns / skills /
// memory summary) for agents whose rows the dashboard has already created.
// DB-leader model: Agent rows are created on dashboard mutation
// (requestCreate / requestImport), never by this endpoint. We UPDATE only —
// if gateway pushes a name we don't know about (e.g. it raced a delete),
// we skip silently. Runtime state (pid/alive/ctx/etc.) lives on ChatSession
// and arrives via /api/sync/session-snapshot.

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
  let skipped = 0;
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
      skills: (a.skills ?? []) as object,
      evolutionFiles: (a.evolutionFiles ?? []) as object,
      memoryFiles: (a.memoryFiles ?? []) as object,
      memorySummary: a.memorySummary ?? null,
      metadataAt: now,
    };
    // updateMany returns count — if zero, the agent row doesn't exist (was
    // deleted, or gateway is pushing for an unknown name). Either way: skip,
    // don't recreate. The dashboard owns row identity.
    const r = await prisma.agent.updateMany({
      where: { machineId: machine.id, name: a.name },
      data,
    });
    if (r.count > 0) updated++; else skipped++;
  }
  return NextResponse.json({ ok: true, updated, skipped });
}
