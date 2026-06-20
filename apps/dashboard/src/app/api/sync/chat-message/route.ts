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

  // Which (sessionId, externalId) rows already exist? A gateway reload /
  // reconnect re-tails the transcript and re-pushes the SAME messages — those
  // are idempotent upsert-UPDATES, not new arrivals. We must NOT bump
  // lastMessageAt for them, or every session flips to "unread" (red dot) on a
  // gateway restart. One batched lookup per session (point scans on the
  // @@unique index), so a streaming flush stays O(n), not O(n^2).
  const extBySession = new Map<string, string[]>();
  for (const i of body.items) {
    if (!i.externalId) continue;
    const arr = extBySession.get(i.sessionId);
    if (arr) arr.push(i.externalId);
    else extBySession.set(i.sessionId, [i.externalId]);
  }
  const existed = new Set<string>(); // `${sessionId}|${externalId}`
  for (const [sid, extIds] of extBySession) {
    const rows = await prisma.chatMessage.findMany({
      where: { sessionId: sid, externalId: { in: extIds } },
      select: { externalId: true },
    });
    for (const r of rows) if (r.externalId) existed.add(`${sid}|${r.externalId}`);
  }
  // Sessions that received a genuinely NEW message this batch → the only ones
  // whose lastMessageAt should advance.
  const freshSessions = new Set<string>();

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
    // New arrival = no externalId (rare system row, always new) OR an externalId
    // we didn't find pre-existing. Re-pushed (already-existing) rows are updates.
    const isNew = !m.externalId || !existed.has(`${m.sessionId}|${m.externalId}`);
    if (isNew) freshSessions.add(m.sessionId);

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

  // Only advance lastMessageAt for sessions that actually got a NEW message —
  // re-pushes on gateway reload update existing rows and must not mark unread.
  if (freshSessions.size > 0) {
    await prisma.chatSession.updateMany({
      where: { id: { in: [...freshSessions] } },
      data: { lastMessageAt: new Date() },
    });
  }
  return NextResponse.json({ ok: true, inserted });
}
