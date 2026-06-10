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
  // Cache session lookups within this batch: a streaming turn POSTs many items
  // for the SAME session, and re-reading the row per item is pure waste on the
  // single-threaded event loop during a reconnect-flush flood.
  const sessionCache = new Map<string, Awaited<ReturnType<typeof prisma.chatSession.findUnique>>>();
  async function getSession(id: string) {
    if (!sessionCache.has(id)) {
      sessionCache.set(id, await prisma.chatSession.findUnique({ where: { id } }));
    }
    return sessionCache.get(id) ?? null;
  }

  for (const m of body.items) {
    const session = await getSession(m.sessionId);
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

    // Dedup by (sessionId, externalId): a streaming partial assistant/tool row
    // keeps updating the SAME message as the turn lands (no row spam, no
    // flicker). Backed by the @@unique index this is a point-lookup upsert — it
    // replaced a per-item findFirst heap scan that went O(n^2) on long sessions
    // and saturated the VPS event loop during reconnect-flush floods (the
    // /api/sync/chat-message 502/timeout storms in the gateway err.log).
    if (m.externalId) {
      await prisma.chatMessage.upsert({
        where: { sessionId_externalId: { sessionId: m.sessionId, externalId: m.externalId } },
        create: { sessionId: m.sessionId, role: m.role, content, externalId: m.externalId },
        update: { role: m.role, content },
      });
    } else {
      // No stable id to dedup on (user-composed rows come via chat.send; a null
      // externalId here is a rare system row) — just insert.
      await prisma.chatMessage.create({
        data: { sessionId: m.sessionId, role: m.role, content, externalId: null },
      });
    }
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
