// The gateway permission hook + the mcp__hermit__ask tool create blocking
// interactions here and then LONG-POLL the GET for the user's decision.
//
//   POST  { sessionId? | claudeSessionId?, kind, payload }  → { id }
//         creates the Interaction + an inline {type:'interaction'} ChatMessage
//         (externalId int-<id>) so the browser renders a card on the SSE stream.
//   GET   ?id=<id>                                          → { status, decision }
//         polled until status != 'pending'.
//
// Machine-keyed (x-asst-key) like the rest of the sync surface. The hook only
// knows claude's session uuid (from the hook stdin), so we resolve the
// ChatSession by claudeSessionId; the mcp stub knows the ChatSession id directly.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { fire as fireChat } from '@/server/chat-bus';
import { resolveMachine } from '../route';
import { stripNulDeep } from '@/server/sanitize';
import { enqueuePush } from '@/server/push';
import { blockedEvent } from '@/server/push/events';

const CreateBody = z.object({
  sessionId: z.string().optional(),
  claudeSessionId: z.string().optional(),
  kind: z.enum(['permission', 'question']),
  payload: z.any(),
});

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof CreateBody>;
  try {
    body = CreateBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  let session = null;
  if (body.sessionId) {
    session = await prisma.chatSession.findUnique({ where: { id: body.sessionId } });
  } else if (body.claudeSessionId) {
    session = await prisma.chatSession.findFirst({
      where: { claudeSessionId: body.claudeSessionId, machineId: machine.id },
      orderBy: { startedAt: 'desc' },
    });
  }
  if (!session || session.machineId !== machine.id) {
    return NextResponse.json({ error: 'session not found' }, { status: 404 });
  }

  // Strip NUL bytes (U+0000): Postgres jsonb/text reject them, aborting the
  // insert. No-op (same ref) when the payload has none.
  const payload = stripNulDeep(body.payload ?? {});

  const interaction = await prisma.interaction.create({
    data: { sessionId: session.id, kind: body.kind, payload: payload as object },
  });

  await prisma.chatMessage.create({
    data: {
      sessionId: session.id,
      role: 'system',
      externalId: `int-${interaction.id}`,
      content: [
        {
          type: 'interaction',
          interactionId: interaction.id,
          kind: body.kind,
          payload,
          status: 'pending',
        },
      ] as object,
    },
  });
  await prisma.chatSession.update({ where: { id: session.id }, data: { lastMessageAt: new Date() } });
  // The agent is blocked until someone answers this — it must appear now, not on
  // the SSE stream's next safety-net poll.
  fireChat(session.id);

  // The agent is now stopped dead waiting on a human. This is the highest-value
  // push there is, and it goes out marked urgent so it pierces a Focus mode.
  // Fire-and-forget: the blocked hook is already long-polling us and must not
  // wait on the push transport.
  enqueuePush(
    blockedEvent({
      machineId: machine.id,
      sessionId: session.id,
      agentName: session.agentName,
      kind: body.kind,
      payload,
    }),
  );

  return NextResponse.json({ id: interaction.id });
}

export async function GET(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const i = await prisma.interaction.findUnique({
    where: { id },
    include: { session: { select: { machineId: true } } },
  });
  if (!i || i.session.machineId !== machine.id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ status: i.status, decision: i.decision });
}
