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
  // Opaque JSON written by the agent's cron / loop skill (readLoopState just
  // JSON.parses the file → any JSON value, or null when absent/corrupt). Kept
  // unvalidated on purpose (z.unknown(), not z.any()): the dashboard treats it as a
  // black box (count chip + expandable detail).
  loopState: z.unknown(),
  // Process-tree RSS of the session's pane, MB (resource governance).
  rssMb: z.number().int().nullable().optional(),
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
  const now = new Date();
  for (const it of body.items) {
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
      // `null` literal is rejected by the generated client.
      loopState: it.loopState == null ? Prisma.DbNull : (it.loopState as Prisma.InputJsonValue),
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

    const r = await prisma.chatSession.updateMany({
      where: { id: it.sessionId, machineId: machine.id },
      data,
    });
    updated += r.count;
  }
  return NextResponse.json({ ok: true, updated });
}
