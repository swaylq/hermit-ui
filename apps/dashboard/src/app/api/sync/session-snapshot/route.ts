// POST /api/sync/session-snapshot — gateway pushes per-session runtime state.
//
// One row per ChatSession: tmux pane PID, alive flag, claude state, latest
// JSONL usage block's context/output tokens, last user prompt + last asst
// text, transcript file path. Dashboard's chat header + agent-detail
// sheet's session list both read these.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { fireStatus, hasStatusSubscriber } from '@/server/chat-bus';
import { syncSessionActivity } from '@/server/push/live-activity';
import { resolveMachine } from '../route';

const Item = z.object({
  sessionId: z.string().min(1),
  pid: z.number().int().nullable().optional(),
  alive: z.boolean().optional(),
  // The collector emits exactly these (session-snapshot.ts): 'starting' (no
  // transcript yet), 'working', 'idle', or null (pane dead). MUST stay in sync with
  // the collector — an unlisted value would 400 the whole batch.
  state: z.enum(['starting', 'working', 'idle']).nullable().optional(),
  contextTokens: z.number().int().nullable().optional(),
  outputTokens: z.number().int().nullable().optional(),
  lastActivity: z.string().datetime().nullable().optional(),
  transcriptPath: z.string().nullable().optional(),
  lastUserPrompt: z.string().nullable().optional(),
  lastAssistantText: z.string().nullable().optional(),
  // Opaque on purpose (z.unknown(), not z.any()): the shape belongs to the
  // gateway's RuntimeActivity and this route has no opinion on it. Explicitly
  // nullable — null is the value that clears a finished session's chip, so it
  // has to survive the round trip rather than being treated as "absent".
  activity: z.unknown(),
  // Process-tree RSS of the session's pane, MB (resource governance).
  rssMb: z.number().int().nullable().optional(),
  /**
   * Write only the keys this item actually carries.
   *
   * The default (full) shape is a REPLACEMENT: every column it knows about is
   * written, and an absent key writes null. That is right for the 8s collector,
   * which probes everything. It is wrong for the gateway's turn-boundary push
   * (collect/session-state-push.ts), which knows `state`/`alive`/`activity` in
   * memory and nothing else — sent as a full item it would blank the transcript
   * path, both prompt snippets and the pane pid on every turn start.
   */
  partial: z.boolean().optional(),
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

  const now = new Date();
  // Each session's data differs, so this isn't a single updateMany — but the N
  // per-session updateManys were previously awaited one at a time (N serial
  // round-trips to the VPS Postgres every 8s push). Build the ops and issue them
  // as ONE `$transaction([...])`: a single round-trip / BEGIN…COMMIT. Atomic per
  // batch (a rare DB error rolls the whole push back instead of committing a
  // prefix — harmless, the collector re-pushes the full snapshot next tick).
  const ops = body.items.map((it) => {
    // A partial item writes what it carries and leaves the rest alone. Nothing
    // below this branch runs for one — in particular the `?? null` defaults,
    // which are exactly what it must not do.
    if (it.partial) {
      const patch: Prisma.ChatSessionUpdateManyMutationInput = { snapshotAt: now };
      if (it.state !== undefined) patch.state = it.state;
      if (it.alive !== undefined) {
        patch.alive = it.alive;
        // Same rule as the full path: a session whose process is back up is no
        // longer hibernated.
        if (it.alive) patch.hibernatedAt = null;
      }
      if (it.activity !== undefined) {
        patch.activity = it.activity == null ? Prisma.DbNull : (it.activity as Prisma.InputJsonValue);
      }
      return prisma.chatSession.updateMany({
        where: { id: it.sessionId, machineId: machine.id },
        data: patch,
      });
    }
    // updateMany scoped to (machineId, id) — silently skips sessions the
    // gateway already cleaned up.
    const data: Prisma.ChatSessionUpdateManyMutationInput = {
      pid: it.pid ?? null,
      alive: it.alive ?? false,
      state: it.state ?? null,
      lastActivity: it.lastActivity ? new Date(it.lastActivity) : null,
      transcriptPath: it.transcriptPath ?? null,
      lastUserPrompt: it.lastUserPrompt ?? null,
      lastAssistantText: it.lastAssistantText ?? null,
      // Prisma's Json? column needs Prisma.DbNull for SQL NULL; a bare
      // `null` literal is rejected by the generated client. Unlike the sticky
      // numeric fields below, this is written on EVERY tick
      // including the null ones: the chip describes a moment, and a moment that
      // has passed must clear rather than linger.
      activity: it.activity == null ? Prisma.DbNull : (it.activity as Prisma.InputJsonValue),
      snapshotAt: now,
    };
    // ctx/output tokens are sticky: a probe that couldn't locate the usage block
    // (a long turn pushed it past the tail window, or a transient timeout under
    // load) sends null — don't overwrite a known value with it, or the ctx %
    // flickers to "—" between turns. Only advance when we actually have a number.
    if (it.contextTokens != null) data.contextTokens = it.contextTokens;
    if (it.outputTokens != null) data.outputTokens = it.outputTokens;
    // rssMb: clear when the pane is dead (memory freed); while alive, advance only
    // on a real number so a transient `ps` miss doesn't flicker the readout to null.
    if (it.alive === false) data.rssMb = null;
    else if (it.rssMb != null) data.rssMb = it.rssMb;
    // Wake: a hibernated session whose pane is back up (user sent → --resume
    // respawn) is no longer hibernated. alive=true ⟺ not hibernated.
    if (it.alive === true) data.hibernatedAt = null;

    return prisma.chatSession.updateMany({
      where: { id: it.sessionId, machineId: machine.id },
      data,
    });
  });
  const results = ops.length ? await prisma.$transaction(ops) : [];
  const updated = results.reduce((sum, r) => sum + r.count, 0);

  // Wake the chat pages that have this session open, so a turn boundary shows up
  // on screen in about the time the POST took rather than on their next 5s poll.
  // `hasStatusSubscriber` first: this loop runs over every session on the machine
  // every 8s, and open chat pages are a handful — the check is a Map lookup and
  // keeps the no-subscriber case free. The SSE handler still decides whether the
  // status actually CHANGED; this only says "worth a look".
  for (const it of body.items) {
    if (hasStatusSubscriber(it.sessionId)) fireStatus(it.sessionId);
  }

  // Same moment, different audience: whoever is looking at a locked phone.
  //
  // Deliberately NOT through enqueuePush — that pipeline's 20s debounce and
  // turn gate exist to avoid interrupting someone mid-turn, and a Live Activity
  // is nothing but mid-turn states. `syncSessionActivity` returns on its first
  // query when the session has no activity, which is almost all of them, and it
  // sends nothing at all unless the content actually changed.
  //
  // Fire-and-forget: this runs on the gateway's 8s tick and on every turn
  // boundary. An APNs round trip must never be in front of that response.
  for (const it of body.items) {
    void syncSessionActivity(it.sessionId).catch((e) =>
      console.warn('[live-activity] sync failed', it.sessionId, e),
    );
  }
  return NextResponse.json({ ok: true, updated });
}
