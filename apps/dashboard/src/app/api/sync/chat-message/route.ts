// Gateway POSTs assistant/tool/system messages produced by the Anthropic SDK
// back here so the browser can see them. Same dedup contract as the rest of
// the sync surface — externalId uniqueness on (sessionId, externalId) keeps
// SDK retries idempotent.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine } from '../route';
import { stripNulDeep } from '@/server/sanitize';

const Item = z.object({
  sessionId: z.string(),
  role: z.string(),
  content: z.any(),
  externalId: z.string().nullable().optional(),
  claudeSessionId: z.string().nullable().optional(), // first message can stamp this on the session
});
const Body = z.object({ items: z.array(Item) });

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = Body.parse(await req.json());
  let inserted = 0;
  for (const m of body.items) {
    const session = await prisma.chatSession.findUnique({ where: { id: m.sessionId } });
    if (!session || session.machineId !== machine.id) continue;

    // Strip NUL bytes (U+0000): Postgres jsonb/text reject them, which aborts
    // the insert and silently drops the message. No-op (same ref) otherwise.
    const content = stripNulDeep(m.content);

    // Stamp claudeSessionId once.
    if (m.claudeSessionId && !session.claudeSessionId) {
      await prisma.chatSession.update({
        where: { id: session.id },
        data: { claudeSessionId: m.claudeSessionId },
      });
    }

    // Upsert by externalId so streaming partial assistant messages keep
    // updating the same row (no row spam, no flicker).
    if (m.externalId) {
      const dup = await prisma.chatMessage.findFirst({
        where: { sessionId: m.sessionId, externalId: m.externalId },
        select: { id: true },
      });
      if (dup) {
        await prisma.chatMessage.update({
          where: { id: dup.id },
          data: { role: m.role, content },
        });
        inserted++;
        continue;
      }
    }

    await prisma.chatMessage.create({
      data: {
        sessionId: m.sessionId,
        role: m.role,
        content,
        externalId: m.externalId ?? null,
      },
    });
    inserted++;
  }

  if (inserted > 0) {
    await prisma.chatSession.updateMany({
      where: { id: { in: [...new Set(body.items.map((i) => i.sessionId))] } },
      data: { lastMessageAt: new Date() },
    });
  }
  return NextResponse.json({ ok: true, inserted });
}
