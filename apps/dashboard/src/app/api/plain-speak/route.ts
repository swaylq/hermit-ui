// /api/plain-speak — rewrite one assistant reply in plain Chinese.
//
// Same shape as /api/translate next door, and for the same reason: the
// OPENROUTER_API_KEY cannot go to the browser, so the text passes through us.
// Same `resolveKey`, same session-ownership check, same promise that a failure
// costs the caller nothing — the reply they asked about is still on screen.
//
// NOTHING IS PERSISTED. The rewrite never reaches the database and never goes
// back to the agent: the transcript stays exactly as the agent wrote it, and
// the browser holds the result (see lib/plain-speak-store.ts).
//
// Body (JSON):
//   sessionId  string   the ChatSession the reply belongs to
//   text       string   the reply's visible prose, flattened by the caller
//
// Returns { text, truncated }. `truncated` means the reply was longer than
// MAX_INPUT_CHARS and only the head of it was rewritten — the note is already
// appended to `text`, the flag is for the UI.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { resolveKey } from '@/server/auth';
import { plainSpeak, acceptPlainSpeak, MAX_INPUT_CHARS, TRUNCATED_NOTE, PLAIN_MODEL } from '@/server/plain-speak';

// A whole reply per request, so this is the ceiling on one round trip. Anything
// above MAX_INPUT_CHARS is cut rather than refused: a 40k-character reply is
// exactly the kind nobody can read, and half an explanation clearly labelled as
// half beats none.
const HARD_CAP = 200_000;

export async function POST(req: NextRequest) {
  const scope = await resolveKey(req.headers.get('x-asst-key') ?? '');
  if (!scope) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { sessionId?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json({ error: 'bad json', detail: String(e) }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const raw = typeof body.text === 'string' ? body.text : '';

  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  if (!raw.trim()) return NextResponse.json({ error: 'text required' }, { status: 400 });
  if (raw.length > HARD_CAP) return NextResponse.json({ error: 'text too large' }, { status: 413 });

  const orKey = process.env.OPENROUTER_API_KEY;
  // Not an error — the reader already has the reply. 503 is the signal the
  // client latches on to stop offering the button, the same contract
  // /api/translate and /api/transcribe/refine use.
  if (!orKey) return NextResponse.json({ error: 'plain speak not configured' }, { status: 503 });

  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, machineId: scope.machine.id, ...(scope.scopedAgent ? { agentName: scope.scopedAgent } : {}) },
    select: { id: true },
  });
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const truncated = raw.length > MAX_INPUT_CHARS;
  const src = truncated ? raw.slice(0, MAX_INPUT_CHARS) : raw;

  try {
    const out = await plainSpeak(orKey, src);
    if (!acceptPlainSpeak(src, out)) {
      console.error(`[plain-speak] gate rejected a ${out.length}-char ${PLAIN_MODEL} reply to a ${src.length}-char message`);
      return NextResponse.json({ error: 'rewrite rejected' }, { status: 502 });
    }
    return NextResponse.json({ text: truncated ? out + TRUNCATED_NOTE : out, truncated });
  } catch (e) {
    console.error('[plain-speak] failed —', String(e));
    return NextResponse.json({ error: 'rewrite failed', detail: String(e) }, { status: 502 });
  }
}
