// REST-shaped push endpoint for happy-push.sh.
// Body: { agent, message, type?, title? }
// Header: X-Asst-Key
// Returns: { ok: true, id }

import { NextResponse, type NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/server/db';

export async function POST(req: NextRequest) {
  const key = req.headers.get('x-asst-key') ?? '';
  if (!key) return NextResponse.json({ error: 'missing X-Asst-Key' }, { status: 401 });

  const prefix = key.slice(0, 8);
  const candidates = await prisma.machine.findMany({ where: { keyPrefix: prefix } });
  let machine: (typeof candidates)[number] | null = null;
  for (const m of candidates) {
    if (await bcrypt.compare(key, m.keyHash)) {
      machine = m;
      break;
    }
  }
  if (!machine) return NextResponse.json({ error: 'invalid key' }, { status: 401 });

  let body: { agent?: string; message?: string; type?: string; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const agent = (body.agent ?? '').trim();
  const message = (body.message ?? '').trim();
  if (!agent || !message)
    return NextResponse.json({ error: 'agent + message required' }, { status: 400 });

  const agentRow = await prisma.agent.findUnique({
    where: { machineId_name: { machineId: machine.id, name: agent } },
  });

  const ev = await prisma.event.create({
    data: {
      machineId: machine.id,
      agentId: agentRow?.id ?? null,
      agentName: agent,
      type: (body.type ?? 'note').slice(0, 32),
      title: body.title ? body.title.slice(0, 120) : null,
      message: message.slice(0, 8000),
    },
  });

  await prisma.machine.update({ where: { id: machine.id }, data: { lastSeen: new Date() } });

  return NextResponse.json({ ok: true, id: ev.id });
}
