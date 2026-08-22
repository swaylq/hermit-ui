// /api/translate — the dashboard's own translation proxy.
//
// Exists for one reason: DASHSCOPE_API_KEY cannot go to the browser, and
// DashScope issues no ephemeral token. Same constraint the dictation socket
// spells out in server/asr-stream.ts, same answer — the text passes through us.
//
// Everything else about the request mirrors /api/transcribe/refine next door:
// the same `resolveKey` (machine key or a shared-agent token), the same
// session-ownership check, the same promise that a failure costs the caller
// nothing because the original text is what they already have on screen.
//
// NOTHING IS PERSISTED. Translations never reach the database, so the agent's
// transcript stays exactly as it was written and the gateway never learns this
// feature exists. The browser holds the results; see lib/translate-store.ts.
//
// Body (JSON):
//   sessionId  string    the ChatSession the text belongs to
//   blocks     string[]  markdown blocks, already cut by lib/translate-text
//   target     'zh'|'en'
//
// Returns { texts: (string | null)[] }, positionally aligned with `blocks`.
// A null means "this one did not translate" — never an error for the whole
// request, because one bad block should not cost the reader the other nine.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { resolveKey } from '@/server/auth';
import { translateBlock, acceptTranslation, MAX_BLOCK_CHARS, TRANSLATE_MODEL } from '@/server/translate';
import type { Lang } from '@/lib/translate-text';

// Blocks per request. The client batches whatever is ready and renders each
// answer as it lands, so this is a fan-out cap rather than a coverage cap —
// a longer reply simply takes more requests.
const MAX_BLOCKS = 8;
// Total across the request, so a batch of eight 6k blocks cannot become one
// 48k round trip.
const MAX_TOTAL_CHARS = 20_000;

export async function POST(req: NextRequest) {
  const scope = await resolveKey(req.headers.get('x-asst-key') ?? '');
  if (!scope) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { sessionId?: unknown; blocks?: unknown; target?: unknown };
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json({ error: 'bad json', detail: String(e) }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const target = (body.target === 'en' ? 'en' : body.target === 'zh' ? 'zh' : null) as Exclude<Lang, 'none'> | null;
  const blocks = Array.isArray(body.blocks) ? body.blocks.filter((b): b is string => typeof b === 'string') : [];

  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  if (!target) return NextResponse.json({ error: "target must be 'zh' or 'en'" }, { status: 400 });
  if (!blocks.length) return NextResponse.json({ error: 'blocks required' }, { status: 400 });
  if (blocks.length > MAX_BLOCKS) return NextResponse.json({ error: `at most ${MAX_BLOCKS} blocks` }, { status: 400 });
  if (blocks.reduce((n, b) => n + b.length, 0) > MAX_TOTAL_CHARS) {
    return NextResponse.json({ error: 'batch too large' }, { status: 413 });
  }

  const dsKey = process.env.DASHSCOPE_API_KEY;
  // Not an error — the reader already has readable text. 503 is the signal the
  // client latches on to stop asking for the rest of the page load, the same
  // contract /api/transcribe/refine uses.
  if (!dsKey) return NextResponse.json({ error: 'translation not configured' }, { status: 503 });

  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, machineId: scope.machine.id, ...(scope.scopedAgent ? { agentName: scope.scopedAgent } : {}) },
    select: { id: true },
  });
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  // Concurrent: the blocks in one batch are independent, and serialising them
  // would turn a batch of six into six round trips of latency for no gain.
  const texts = await Promise.all(
    blocks.map(async (src) => {
      if (!src.trim() || src.length > MAX_BLOCK_CHARS) return null;
      try {
        const out = await translateBlock(dsKey, src, target);
        if (!acceptTranslation(src, out, target)) {
          console.error(`[translate] gate rejected a ${out.length}-char ${TRANSLATE_MODEL} reply to a ${src.length}-char block`);
          return null;
        }
        return out;
      } catch (e) {
        console.error('[translate] block failed —', String(e));
        return null;
      }
    }),
  );

  return NextResponse.json({ texts });
}
