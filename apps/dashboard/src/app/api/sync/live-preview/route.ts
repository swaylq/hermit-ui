// POST /api/sync/live-preview — the gateway's preview module registers (or
// clears) a session's live preview. One row, one Json column; the chat page's
// 5s getSession poll turns it into the preview FAB. Modeled on
// session-snapshot: resolveMachine + (machineId, id)-scoped updateMany, so a
// key can never write another machine's session.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { resolveMachine } from '../route';

const LivePreview = z.object({
  url: z.string().url().max(500),
  mode: z.enum(['static', 'proxy']),
  target: z.string().max(500),
  updatedAt: z.string(),
});
const Body = z.object({
  sessionId: z.string().min(1),
  livePreview: LivePreview.nullable(),
});

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  const r = await prisma.chatSession.updateMany({
    where: { id: body.sessionId, machineId: machine.id },
    data: {
      livePreview: body.livePreview == null ? Prisma.DbNull : (body.livePreview as Prisma.InputJsonValue),
    },
  });
  return NextResponse.json({ ok: true, updated: r.count });
}
