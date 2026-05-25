// POST /api/sync/session-snapshot — gateway pushes per-session runtime state.
//
// One row per ChatSession: tmux pane PID, alive flag, claude state, latest
// JSONL usage block's context/output tokens, last user prompt + last asst
// text, transcript file path. Dashboard's chat header + agent-detail
// sheet's session list both read these.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
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
    const r = await prisma.chatSession.updateMany({
      where: { id: it.sessionId, machineId: machine.id },
      data: {
        pid: it.pid ?? null,
        alive: it.alive ?? false,
        state: it.state ?? null,
        contextTokens: it.contextTokens ?? null,
        outputTokens: it.outputTokens ?? null,
        lastActivity: it.lastActivity ? new Date(it.lastActivity) : null,
        transcriptPath: it.transcriptPath ?? null,
        lastUserPrompt: it.lastUserPrompt ?? null,
        lastAssistantText: it.lastAssistantText ?? null,
        snapshotAt: now,
      },
    });
    updated += r.count;
  }
  return NextResponse.json({ ok: true, updated });
}
