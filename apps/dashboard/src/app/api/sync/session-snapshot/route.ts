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
  state: z.string().nullable().optional(),
  contextTokens: z.number().int().nullable().optional(),
  outputTokens: z.number().int().nullable().optional(),
  lastActivity: z.string().datetime().nullable().optional(),
  transcriptPath: z.string().nullable().optional(),
  lastUserPrompt: z.string().nullable().optional(),
  lastAssistantText: z.string().nullable().optional(),
  // Opaque JSON written by the agent's cron skill — dashboard treats it as
  // a black box (renders a count chip + an expandable detail dropdown).
  loopState: z.any().nullable().optional(),
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

    const r = await prisma.chatSession.updateMany({
      where: { id: it.sessionId, machineId: machine.id },
      data,
    });
    updated += r.count;
  }
  return NextResponse.json({ ok: true, updated });
}
