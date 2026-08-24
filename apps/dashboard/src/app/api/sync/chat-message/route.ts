// Gateway POSTs assistant/tool/system messages produced by the Anthropic SDK
// back here so the browser can see them. Same dedup contract as the rest of
// the sync surface — externalId uniqueness on (sessionId, externalId) keeps
// SDK retries idempotent.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine } from '../route';
import { stripNulDeep } from '@/server/sanitize';
import { enqueuePush } from '@/server/push';
import { chatEvent, loopRoundEvent } from '@/server/push/events';
import { loopRoundLine } from '@/lib/loop-marker';
import { fire as fireChat } from '@/server/chat-bus';

const Item = z.object({
  sessionId: z.string(),
  role: z.string(),
  // Gateway-pushed content: always an array of Anthropic content blocks
  // (text / tool_use / tool_result / image / thinking) — see chat-runner's
  // normalizeContent — or a plain string. Not a strict per-block schema (block
  // shapes are the SDK's and evolve), but no longer z.any(): a null / number /
  // bare object is now rejected. Deliberately permissive — one bad item 400s the
  // whole batch, so over-tightening here would drop good messages with it.
  content: z.union([z.string(), z.array(z.unknown())]),
  externalId: z.string().nullable().optional(),
  claudeSessionId: z.string().nullable().optional(), // first message can stamp this on the session
  // Retract the row this externalId names instead of writing it. The gateway
  // streams a turn's text into a placeholder row and retracts it in the same
  // batch that inserts the finished message, so the growing bubble becomes the
  // real one in a single push rather than being briefly duplicated. `content` is
  // ignored on a retraction; it stays required so the item shape does not fork.
  deleted: z.boolean().optional(),
  // A preview of a reply still being written: write it, wake the open stream,
  // but do not call it an arrival. Marking the session unread and buzzing a
  // phone belong to the finished message, which lands moments later.
  transient: z.boolean().optional(),
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
  // Last NEW assistant message per session, for the push notification. Re-pushed
  // rows are excluded by the same isNew test as freshSessions, so a gateway
  // restart re-tailing a transcript can't notify about hours-old replies.
  const pushable = new Map<string, { agentName: string; content: unknown }>();
  // Loop ROUND reports in this batch, per session — tracked apart from
  // `pushable` because that map keeps only the batch's LAST assistant message,
  // and a round report is routinely followed by more chatter in the same batch.
  // Losing it there is the bug this fixes, not a detail of it.
  const loopRounds = new Map<string, { agentName: string; line: string }>();
  // Sessions this batch actually wrote rows for — new OR streamed-growth upsert.
  // The SSE stream must be woken for BOTH: an UPDATE is a growing bubble.
  const dirtySessions = new Set<string>();

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

    if (m.deleted) {
      // No externalId, nothing to name — and never a session-wide delete.
      if (!m.externalId) continue;
      const { count } = await prisma.chatMessage.deleteMany({
        where: { sessionId: m.sessionId, externalId: m.externalId },
      });
      // Only wake the stream if a row actually went away. Retracting a
      // placeholder that was never written (a turn short enough that the first
      // throttled push never fired) is a no-op, not an event.
      if (count > 0) dirtySessions.add(m.sessionId);
      continue;
    }

    // Strip NUL bytes (U+0000): Postgres jsonb/text reject them, which aborts
    // the insert and silently drops the message. No-op (same ref) otherwise.
    // The union schema narrows content to string|unknown[]; the column is opaque
    // JSON, so cast to its accepted type at the write boundary (same idiom as the
    // chat.send path in routers/chat.ts). Runtime validation already happened above.
    const content = stripNulDeep(m.content) as unknown as Parameters<
      typeof prisma.chatMessage.create
    >[0]['data']['content'];

    // Stamp claudeSessionId whenever the gateway reports one that DIFFERS from what
    // we hold — this both fills a null on the first sync AND corrects a stale pointer
    // after uuid drift (a `--resume` forked a new uuid, or the recorded transcript was
    // pruned by Claude Code's retention so the gateway drift-adopted the pane's live
    // transcript). The gateway only sends a non-null claudeSessionId while its own
    // `uuidStamped` flag is false — i.e. exactly when the DB needs reconciling — and
    // stops once this write's sync succeeds, so this converges (not a write per message).
    //
    // The old `!session.claudeSessionId` guard (stamp ONLY when null) meant a drifted
    // session's DB pointer stayed pinned to a DEAD uuid forever. The session-snapshot
    // collector resolves the transcript from that DB uuid; a pruned uuid → no file →
    // it reports state='starting' permanently, so the session was stuck showing
    // "starting" in the UI with no way to self-heal (observed 2026-07-13: zhinan-dingding
    // pinned to a pruned uuid; the gateway had already drift-adopted the live transcript
    // in-memory, but this route refused to write the correction through).
    if (m.claudeSessionId && m.claudeSessionId !== session.claudeSessionId) {
      await prisma.chatSession.update({
        where: { id: session.id },
        data: { claudeSessionId: m.claudeSessionId },
      });
      session.claudeSessionId = m.claudeSessionId; // keep the per-batch cache coherent
    }

    // Dedup by (sessionId, externalId): a streaming partial assistant/tool row
    // keeps updating the SAME message as the turn lands (no row spam, no
    // flicker). Backed by the @@unique index this is a point-lookup upsert — it
    // replaced a per-item findFirst heap scan that went O(n^2) on long sessions
    // and saturated the VPS event loop during reconnect-flush floods (the
    // /api/sync/chat-message 502/timeout storms in the gateway err.log).
    // New arrival = no externalId (rare system row, always new) OR an externalId
    // we didn't find pre-existing. Re-pushed (already-existing) rows are updates.
    const isNew = (!m.externalId || !existed.has(`${m.sessionId}|${m.externalId}`)) && !m.transient;
    if (isNew) freshSessions.add(m.sessionId);
    // Overwrite, don't accumulate: a turn's LAST assistant message is the one
    // worth putting on the lock screen (earlier ones are usually preamble before
    // tool calls). chatEvent() drops it later if it carries no text at all.
    if (isNew && m.role === 'assistant') {
      pushable.set(m.sessionId, { agentName: session.agentName, content });
      // A loop round is kept separately AND is not overwritten by a later round
      // in the same batch only because rounds are an hour apart — if two ever
      // did land together, the last one is still the right one to announce.
      const line = loopRoundLine(content);
      if (line) loopRounds.set(m.sessionId, { agentName: session.agentName, line });
    }

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
    dirtySessions.add(m.sessionId);
    inserted++;
  }

  // One clock for both stamps below. Two `new Date()` calls a few ms apart would
  // let lastLoopRoundAt land AFTER lastMessageAt, and a read marker falling
  // between them would read as "an unread round on a session with nothing
  // unread" — a state neither dot branch is written for.
  const arrivedAt = new Date();

  // Only advance lastMessageAt for sessions that actually got a NEW message —
  // re-pushes on gateway reload update existing rows and must not mark unread.
  if (freshSessions.size > 0) {
    await prisma.chatSession.updateMany({
      where: { id: { in: [...freshSessions] } },
      data: { lastMessageAt: arrivedAt },
    });
  }

  // Stamp when a loop round last landed, so the status dot can tell "the agent
  // finished a round you have not read" from "a background task is still
  // running". The dot cannot read it off `lastMessageAt` or the preview: both
  // move with every later message, and on a looping session there are dozens
  // between rounds. One UPDATE per round (hourly), not per message.
  if (loopRounds.size > 0) {
    await prisma.chatSession.updateMany({
      where: { id: { in: [...loopRounds.keys()] } },
      data: { lastLoopRoundAt: arrivedAt },
    });
  }

  // Notify AFTER the writes land. enqueuePush debounces chat events ~20s per
  // session, so a long streaming turn — which arrives as many of these batches —
  // still results in exactly one notification carrying its final text.
  //
  // A session that reported a loop round in this batch is announced by that
  // round and NOT also by the ordinary chat event: the round is the conclusion,
  // the chat event would be the narration on the way to it. enqueuePush also
  // drops any chat event already held for the session for the same reason.
  for (const [sessionId, { agentName, content }] of pushable) {
    if (loopRounds.has(sessionId)) continue;
    const event = chatEvent({ machineId: machine.id, sessionId, agentName, content });
    if (event) enqueuePush(event);
  }
  for (const [sessionId, { agentName, line }] of loopRounds) {
    enqueuePush(loopRoundEvent({ machineId: machine.id, sessionId, agentName, line }));
  }
  // 广播落库信号：同进程的 /api/chat/stream SSE handler 立即 tick 推送，
  // 不再等下一次 Postgres 轮询。新增与流式增长（upsert-UPDATE）都广播——都要推。
  for (const sid of dirtySessions) fireChat(sid);

  return NextResponse.json({ ok: true, inserted });
}
