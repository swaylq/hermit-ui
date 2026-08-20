// /api/transcribe/refine — the whole-passage correction that runs once, when a
// dictation run ends.
//
// Text in, text out; no audio. Everything else about it mirrors the batch route
// next door — same auth, same session-ownership check, same provider preference
// (DashScope direct when its key is set, OpenRouter otherwise), same promise
// that a failure costs the user nothing because their own words are what we
// already have. Why the step exists at all, and what it is allowed to change,
// is in server/transcribe-refine.ts.
//
// Deliberately HTTP rather than another message on the dictation socket: the
// socket is machine-key only (see server/asr-ws.ts), and a shared agent's
// dictation — which degrades to the batch path and is therefore polished in ONE
// piece — is the case that needs this least but should still be able to ask.
// Over here `resolveKey` accepts both kinds of token, and the whole exchange is
// one request at the end of a run.
//
// Body (JSON):
//   sessionId  string   the ChatSession being dictated into
//   text       string   the passage as the composer has it
//   style      'rewrite' | 'minimal'   this device's setting; unknown → rewrite
//   preceding  string?  what was in the composer before the run (reference only)
//
// Returns { text, refined } — `text` is what the composer should show, which on
// any failure or gate rejection is exactly what was sent.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { resolveKey } from '@/server/auth';
import { dashscopeChat } from '@/server/dashscope';
import { openrouterChat, type ORMessage } from '@/server/openrouter';
import { inventedTerm, type PolishStyle } from '@/server/transcribe-polish';
import { refineSystem, refinePrompt, acceptRefine } from '@/server/transcribe-refine';
import { loadContext } from '@/server/transcribe-context';

const DASHSCOPE_MODEL = process.env.DASHSCOPE_POLISH_MODEL || 'qwen-flash';
const OPENROUTER_MODEL = process.env.OPENROUTER_POLISH_MODEL || 'deepseek/deepseek-v4-flash';

// A dictation run is capped at 20 minutes and the silence gate closes long
// before that, so a passage past this is not speech — and a passage this long
// is one the user is about to send anyway. Skipped rather than truncated:
// truncating would hand back a passage with its ending amputated.
const MAX_PASSAGE_CHARS = 4_000;
// What was already in the composer, as reference. Enough to carry the terms and
// the sentence a second run is continuing; not enough to become the input.
const MAX_PRECEDING_CHARS = 300;

export async function POST(req: NextRequest) {
  const scope = await resolveKey(req.headers.get('x-asst-key') ?? '');
  if (!scope) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { sessionId?: unknown; text?: unknown; style?: unknown; preceding?: unknown };
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json({ error: 'bad json', detail: String(e) }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const text = typeof body.text === 'string' ? body.text : '';
  const style: PolishStyle = body.style === 'minimal' ? 'minimal' : 'rewrite';
  const preceding = (typeof body.preceding === 'string' ? body.preceding : '').slice(-MAX_PRECEDING_CHARS);
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  if (!text.trim()) return NextResponse.json({ error: 'text required' }, { status: 400 });

  const orKey = process.env.OPENROUTER_API_KEY;
  const dsKey = process.env.DASHSCOPE_API_KEY;
  // Not an error: the composer already holds text that is usable. Say so and
  // let the client stop asking (503, same as the batch route's no-key case).
  if (!orKey && !dsKey) return NextResponse.json({ error: 'refine not configured' }, { status: 503 });
  if (text.length > MAX_PASSAGE_CHARS) return NextResponse.json({ text, refined: false });

  // Session ownership, mirroring /api/transcribe: the session must belong to
  // this machine, and to the shared agent when the token is scoped to one.
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, machineId: scope.machine.id, ...(scope.scopedAgent ? { agentName: scope.scopedAgent } : {}) },
    select: { id: true },
  });
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const context = await loadContext(prisma, sessionId);
  const messages: ORMessage[] = [
    { role: 'system', content: refineSystem(style) },
    { role: 'user', content: refinePrompt(text, context, preceding) },
  ];

  try {
    // temperature 0, like the per-sentence step and unlike the batch route's
    // 0.2: this is a correction with a right answer, not a composition.
    const out = dsKey
      ? await dashscopeChat(dsKey, DASHSCOPE_MODEL, messages, { temperature: 0, timeoutMs: 20_000 })
      : await openrouterChat(orKey!, OPENROUTER_MODEL, messages, { temperature: 0, reasoningOff: true, timeoutMs: 25_000 });

    // Two gates, both meaning "keep what the user already has". acceptRefine
    // catches the model answering the passage or summarising it; inventedTerm
    // catches it naming a library nobody mentioned. The passage reaching this
    // step has already been through inventedTerm sentence by sentence, but the
    // whole-passage pass is where a term can be "unified" into something new.
    if (!acceptRefine(text, out)) {
      console.error(`[refine] gate rejected a ${out.length}-char reply to a ${text.length}-char passage`);
      return NextResponse.json({ text, refined: false });
    }
    const invented = inventedTerm(text, out, `${context}\n${preceding}`);
    if (invented) {
      console.error(`[refine] invented "${invented}" — keeping the passage`);
      return NextResponse.json({ text, refined: false });
    }
    return NextResponse.json({ text: out, refined: out !== text });
  } catch (e) {
    console.error('[refine] failed, keeping the passage —', String(e));
    return NextResponse.json({ text, refined: false });
  }
}
