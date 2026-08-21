// POST /api/sync/claude-models — the gateway reports what Claude Code on this
// machine can run, straight from the SDK's `supportedModels()` control request.
//
// Cached on Machine.claudeModels so the chat model picker offers the aliases
// THAT machine's CLI would accept, rather than a list the dashboard maintains
// and cannot keep true. Idempotent: the gateway pushes on the first claude-sdk
// session of its lifetime and again whenever the answer changes.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine } from '../route';

const Model = z.object({
  value: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).optional(),
});
// Capped rather than unbounded: this column is read on every chat page load,
// and a malformed push should not be able to grow it without limit.
const Body = z.object({ models: z.array(Model).max(40) });

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  // An empty list is a report we refuse to store: it would replace a good
  // catalogue with one the picker cannot render, and "the CLI answered nothing"
  // is indistinguishable here from "the control request failed".
  if (body.models.length === 0) return NextResponse.json({ ok: true, stored: false });

  await prisma.machine.update({
    where: { id: machine.id },
    data: { claudeModels: body.models },
  });
  return NextResponse.json({ ok: true, stored: true });
}
