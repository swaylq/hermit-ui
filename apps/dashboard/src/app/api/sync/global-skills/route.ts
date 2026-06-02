// POST /api/sync/global-skills — the gateway pushes the FULL current set of
// machine-global skills from ~/.claude/skills/. The filesystem is the source of
// truth: upsert every pushed skill and delete any GlobalSkill rows for this
// machine that aren't in the push (so on-disk deletions reflect). Mutations are
// queued separately as GlobalSkillRequest and applied on-disk by the gateway.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { resolveMachine, GlobalSkillInput } from '../route';

const Body = z.object({ skills: z.array(GlobalSkillInput) });

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
  const names = body.skills.map((s) => s.name);
  for (const s of body.skills) {
    const data = {
      description: s.description ?? null,
      content: s.content ?? null,
      refs: (s.refs ?? []) as object,
      source: s.source ?? 'manual',
      isBundle: s.isBundle ?? false,
      subSkills: s.subSkills ?? [],
      fileCount: s.fileCount ?? 0,
      metadataAt: now,
    };
    await prisma.globalSkill.upsert({
      where: { machineId_name: { machineId: machine.id, name: s.name } },
      create: { machineId: machine.id, name: s.name, ...data },
      update: data,
    });
  }
  // Filesystem-led: drop rows for skills that no longer exist on disk. The ''
  // sentinel makes an empty push (no skills on disk) delete everything, since no
  // directory can be named the empty string.
  const del = await prisma.globalSkill.deleteMany({
    where: { machineId: machine.id, name: { notIn: names.length ? names : [''] } },
  });
  return NextResponse.json({ ok: true, upserted: body.skills.length, deleted: del.count });
}
