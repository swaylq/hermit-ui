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
  for (const a of body.agents) {
    await prisma.agent.upsert({
      where: { machineId_name: { machineId: machine.id, name: a.name } },
      create: {
        machineId: machine.id,
        name: a.name,
        pid: a.pid ?? null,
        alive: a.alive ?? false,
        state: a.state ?? null,
        contextTokens: a.contextTokens ?? null,
        outputTokens: a.outputTokens ?? null,
        lastActivity: a.lastActivity ? new Date(a.lastActivity) : null,
        transcriptPath: a.transcriptPath ?? null,
      },
      update: {
        pid: a.pid ?? null,
        alive: a.alive ?? false,
        state: a.state ?? null,
        contextTokens: a.contextTokens ?? null,
        outputTokens: a.outputTokens ?? null,
        lastActivity: a.lastActivity ? new Date(a.lastActivity) : null,
        transcriptPath: a.transcriptPath ?? null,
      },
    });
    updated++;
  }
  return NextResponse.json({ ok: true, updated });
}
