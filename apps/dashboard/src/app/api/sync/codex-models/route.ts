// POST /api/sync/codex-models — the gateway reports what codex on this machine
// can run, read off the catalogue codex caches for itself
// (`<CODEX_HOME>/models_cache.json`), plus the model that gateway resolves when
// a session pins none.
//
// The catalogue half mirrors /api/sync/claude-models exactly. The `default` half
// has no counterpart there and is the reason this endpoint carries more than a
// list: the resolved default lives in a gateway constant and a machine env var,
// so the dashboard cannot derive it, and without it the model chip on an
// unpinned codex session can only say "default".
//
// Idempotent: the gateway pushes on the first codex session of its lifetime and
// again whenever the answer changes.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine } from '../route';

const Model = z.object({
  value: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).optional(),
});
// Same cap as the claude catalogue: this column is read on every chat page load
// of a codex session, and a malformed push should not be able to grow it without
// limit.
const Body = z.object({
  models: z.array(Model).max(40),
  default: z.string().trim().min(1).max(128).optional(),
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

  // An empty list is a report we refuse to store, for the reason claude's route
  // gives: it would replace a good catalogue with one the picker cannot render,
  // and "codex's cache was missing" is indistinguishable here from "the machine
  // genuinely offers nothing".
  if (body.models.length === 0) return NextResponse.json({ ok: true, stored: false });

  await prisma.machine.update({
    where: { id: machine.id },
    data: { codexModels: { models: body.models, ...(body.default ? { default: body.default } : {}) } },
  });
  return NextResponse.json({ ok: true, stored: true });
}
