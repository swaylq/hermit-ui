// /api/sync/agent-snapshot — gateway pushes per-agent JSONL tail snippets here.
// Lets the dashboard's /agents detail sheet read `lastUserPrompt` and
// `lastAssistantText` directly from postgres instead of shelling out a
// `grep | jq` pipe against the agent's transcript file on every detail open.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine } from '../route';

const Item = z.object({
  name: z.string().min(1).max(64),
  lastUserPrompt: z.string().nullable().optional(),
  lastAssistantText: z.string().nullable().optional(),
});
const Body = z.object({ items: z.array(Item) });

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
  for (const it of body.items) {
    // updateMany so we silently skip agents the gateway hasn't synced yet
    // (the agents.sync tick creates the row first; snapshot is best-effort).
    const r = await prisma.agent.updateMany({
      where: { machineId: machine.id, name: it.name },
      data: {
        lastUserPrompt: it.lastUserPrompt ?? null,
        lastAssistantText: it.lastAssistantText ?? null,
        snapshotAt: new Date(),
      },
    });
    updated += r.count;
  }
  return NextResponse.json({ ok: true, updated });
}
