// /api/transcribe — voice-input transcription endpoint.
//
// Accepts multipart/form-data:
//   sessionId  <string>  ChatSession id (must belong to the auth machine/agent)
//   wav        <Blob>    16 kHz mono PCM16 WAV recorded in the browser, ≤ ~15 MB
//
// Two steps, ASR then polish. Provider is chosen by which key is set:
//   · DASHSCOPE_API_KEY → BOTH steps go DIRECT to DashScope (the Keyo path, one
//     key + datacenter, no OpenRouter hop): ASR = qwen3-asr-flash (a dedicated
//     fast ASR, ~1s), polish = qwen-flash (~0.5s). ASR errors fall back to
//     OpenRouter when its key is also set.
//   · else → OpenRouter: ASR = an audio model (default mistralai/voxtral-small-24b,
//     a dedicated ASR far faster + steadier than a general multimodal LLM),
//     polish = deepseek-v4-flash.
// The recent conversation (server/transcribe-context.ts) rides along: the agent's
// FINAL replies plus the user's own messages, a few hundred characters, no tool
// traffic. Dictation is a follow-on to what was just said, and the words most
// likely to be misheard — repo names, agent names, CLI flags — are usually sitting
// in the last reply. DashScope ASR takes it through qwen3-asr's own 定制化识别
// channel and polish takes it as fenced reference material; the OpenRouter ASR leg
// does not (see orAsrMessages).
//
// Polish cleans the dictation into fluent, correct written text — fix ASR errors
// (typos, misheard zh/en tech terms, spoken symbols), drop spoken noise (fillers,
// repeats, redundancy), mend broken sentences, arrange an explicitly-dictated
// list — WITHOUT ever losing information/meaning, adding content, or answering a
// spoken question. The prompt, the fences that make transcript and context data
// rather than instruction, and the guard that catches the model answering anyway
// all live in server/transcribe-polish.ts. On failure we keep raw.
//
// Returns { text, raw }. Auth mirrors /api/upload (resolveKey + session
// ownership). Server-side only — keys never reach the client.
//
// Env: OPENROUTER_API_KEY and/or DASHSCOPE_API_KEY (at least one required).
// Overrides: OPENROUTER_ASR_MODEL, OPENROUTER_POLISH_MODEL, DASHSCOPE_ASR_MODEL,
// DASHSCOPE_POLISH_MODEL, DASHSCOPE_BASE_URL (default https://dashscope.aliyuncs.com
// — the China/Beijing endpoint, matching Keyo; a Model Studio workspace uses its
// own https://<ws>.<region>.maas.aliyuncs.com host; Alibaba Cloud International is
// https://dashscope-intl.aliyuncs.com).

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { resolveKey } from '@/server/auth';

import { openrouterChat, type ORMessage } from '@/server/openrouter';
import { dashscopeChat, DASHSCOPE_BASE_URL } from '@/server/dashscope';
import { POLISH_SYSTEM, MINIMAL_POLISH_SYSTEM, polishPrompt, acceptPolish, type PolishStyle } from '@/server/transcribe-polish';
import { loadContext, isContextEcho } from '@/server/transcribe-context';

const ASR_MODEL = process.env.OPENROUTER_ASR_MODEL || 'mistralai/voxtral-small-24b-2507';
const POLISH_MODEL = process.env.OPENROUTER_POLISH_MODEL || 'deepseek/deepseek-v4-flash';

const DASHSCOPE_ASR_MODEL = process.env.DASHSCOPE_ASR_MODEL || 'qwen3-asr-flash';
const DASHSCOPE_POLISH_MODEL = process.env.DASHSCOPE_POLISH_MODEL || 'qwen-flash';

// 16 kHz mono PCM16 WAV is ~32 KB/s; the client caps recording at ~60 s (~2 MB).
// 15 MB is a generous safety net that still base64-encodes under the audio ceiling.
const MAX_WAV_BYTES = 15 * 1024 * 1024;

const ASR_SYSTEM =
  'You are a speech-to-text engine. Output ONLY the verbatim transcript of the audio, ' +
  'preserving the original language(s) (mixed Chinese/English is common). Do NOT translate, ' +
  'answer, summarize, comment, or wrap the output in quotes. Add only the punctuation that is ' +
  'actually spoken. If the audio is empty or unintelligible, output an empty string.';

// OpenRouter ASR request messages: audio as raw base64 + a separate format field.
//
// Deliberately gets NO conversation context. voxtral has no context parameter, so
// the only channel is its system prompt, and a general audio model handed loose
// text next to audio does something with it: tried live on the same clips, a
// fenced "reference only" block got the terms right and then TRANSLATED the
// speech — 「把 rathole 的隧道重启一下」 came back as "Please restart the rathole
// tunnel.", and 「兜底」 as 「那台笔记本」. This is the emergency leg that runs when
// DashScope is down; it stays exactly as it was, and the polish step (which does
// get the context) still repairs the terms afterwards.
function orAsrMessages(base64: string): ORMessage[] {
  return [
    { role: 'system', content: ASR_SYSTEM },
    { role: 'user', content: [
      { type: 'text', text: '转写这段音频。' },
      { type: 'input_audio', input_audio: { data: base64, format: 'wav' } },
    ] },
  ];
}

// Polish messages (text in → cleaned text out); shared by both providers. The
// `style` picks which polish the user chose for THIS device (see transcribe-polish:
// `rewrite` = rewrite into fluent written text — the default; `minimal` = keep the
// user's own words, correct only typos / English spelling / grammar).
function polishMessages(raw: string, context: string, style: PolishStyle): ORMessage[] {
  return [
    { role: 'system', content: style === 'minimal' ? MINIMAL_POLISH_SYSTEM : POLISH_SYSTEM },
    { role: 'user', content: polishPrompt(raw, context) },
  ];
}

// An HTTP status carried out of a failed provider call, so the caller can tell
// "this request was refused" from "the provider was unreachable" — the difference
// between retrying differently and retrying at all.
class ProviderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Direct DashScope qwen3-asr-flash (OpenAI-compatible). Differs from OpenRouter:
// the audio is a data-URI in input_audio.data, and asr_options sits at the body
// TOP LEVEL (per Alibaba's docs + Keyo's live testing — nesting it elsewhere is
// silently dropped). Language omitted → auto (Chinese/English mix).
//
// The system message is qwen3-asr's own 定制化识别 channel: free-form background
// text that biases decoding toward the words in it (no format required, no
// instruction semantics). It has to be a CONTENT-BLOCK ARRAY, not the plain
// string Alibaba's OpenAI-compatible page shows — a string is refused outright
// (400 "the dedicated task `asr` … does not support this input") on both the
// workspace host and the public one. Measured on live audio, same clip:
//   no system message      → 「把 red hole 的隧道重启一下」
//   system [{type,text}]   → 「把 rathole 的隧道重启一下」
//   asr_options.context    → 「把 Red Hole 的隧道重启一下」  (accepted, ignored)
async function transcribeViaDashScope(apiKey: string, wavBase64: string, context: string, timeoutMs = 30_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${DASHSCOPE_BASE_URL}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DASHSCOPE_ASR_MODEL,
        messages: [
          ...(context ? [{ role: 'system', content: [{ type: 'text', text: context }] }] : []),
          { role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wavBase64}` } }] },
        ],
        asr_options: { enable_itn: false },
      }),
      signal: controller.signal,
    });
    const j = (await r.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string }; message?: string; code?: string }
      | null;
    if (!r.ok) throw new ProviderError(`DashScope HTTP ${r.status}: ${j?.error?.message ?? j?.message ?? j?.code ?? 'unknown'}`, r.status);
    return (j?.choices?.[0]?.message?.content ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

// Context is a nice-to-have; the user's words are not. Two ways it can spoil an
// otherwise fine transcription, and the answer to both is the same — do the call
// again the way it worked before this feature existed:
//
//   · REFUSED (4xx) — a different ASR model, a deployment that takes no system
//     message, a context that trips some limit. Not retried on timeouts or 5xx:
//     the context isn't why those failed, and a second full-length attempt would
//     only double the wait before the real fallback.
//   · ECHOED — the model transcribed the context instead of the audio, which
//     silence reliably provokes. See isContextEcho.
async function transcribeWithContext(
  attempt: (context: string) => Promise<string>,
  context: string,
): Promise<string> {
  if (!context) return attempt('');
  let out: string;
  try {
    out = await attempt(context);
  } catch (e) {
    const status = e instanceof ProviderError ? e.status : 0;
    if (status < 400 || status >= 500) throw e;
    console.error('[transcribe] ASR refused the context, retrying without it —', String(e));
    return attempt('');
  }
  if (isContextEcho(out, context)) {
    console.error('[transcribe] ASR echoed the context back, retrying without it');
    return attempt('');
  }
  return out;
}

export async function POST(req: NextRequest) {
  const scope = await resolveKey(req.headers.get('x-asst-key') ?? '');
  if (!scope) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const orKey = process.env.OPENROUTER_API_KEY;
  const dsKey = process.env.DASHSCOPE_API_KEY;
  if (!orKey && !dsKey) return NextResponse.json({ error: 'transcription not configured' }, { status: 503 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json({ error: 'bad form data', detail: String(e) }, { status: 400 });
  }

  const sessionId = (form.get('sessionId') as string | null)?.trim();
  const wav = form.get('wav');
  // The polish style the user picked on THIS device (double-click the mic → 设置).
  // Anything unknown resolves to the default `rewrite`, so an old client or a
  // hand-rolled request still gets the established behaviour.
  const style: PolishStyle = form.get('style') === 'minimal' ? 'minimal' : 'rewrite';
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  if (!(wav instanceof Blob)) return NextResponse.json({ error: 'wav blob required' }, { status: 400 });
  if (wav.size === 0) return NextResponse.json({ error: 'empty audio' }, { status: 400 });
  if (wav.size > MAX_WAV_BYTES) return NextResponse.json({ error: 'audio too long' }, { status: 413 });

  // Session ownership (mirror /api/upload): the session must belong to this
  // machine, and — for a scoped agent share token — to that agent. Blocks
  // cross-tenant use + quota abuse of the ASR credits.
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, machineId: scope.machine.id, ...(scope.scopedAgent ? { agentName: scope.scopedAgent } : {}) },
    select: { id: true },
  });
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  // What this chat was just talking about — a few lines, agent replies only, and
  // only their FINAL text (see server/transcribe-context.ts). Both steps get it:
  // ASR to bias decoding toward names already on screen, polish to restore the
  // ones ASR still missed. Read while the audio is being encoded, and never fatal
  // — no context just means the old behaviour.
  const contextP = loadContext(prisma, sessionId);
  const base64 = Buffer.from(await wav.arrayBuffer()).toString('base64');
  const context = await contextP;

  // ① ASR — DashScope qwen3-asr-flash direct when its key is set (fast Keyo path);
  // its errors fall back to OpenRouter voxtral when possible. Fatal only if all fail.
  let raw: string;
  try {
    if (dsKey) {
      try {
        raw = await transcribeWithContext((c) => transcribeViaDashScope(dsKey, base64, c), context);
      } catch (e) {
        if (!orKey) throw e;
        raw = await openrouterChat(orKey, ASR_MODEL, orAsrMessages(base64), { timeoutMs: 60_000 });
      }
    } else {
      // orKey is guaranteed here: the 503 above rules out "neither key set".
      raw = await openrouterChat(orKey!, ASR_MODEL, orAsrMessages(base64), { timeoutMs: 60_000 });
    }
  } catch (e) {
    return NextResponse.json({ error: 'transcription failed', detail: String(e) }, { status: 502 });
  }
  if (!raw) return NextResponse.json({ text: '', raw: '' });

  // ② polish — best-effort. Prefer DashScope qwen (same key + datacenter as the
  // ASR when set, ~0.5s); else OpenRouter deepseek. Fall back to the raw
  // transcript on any failure / no key so the user never loses their words.
  let text = raw;
  try {
    let polished = '';
    if (dsKey) {
      polished = await dashscopeChat(dsKey, DASHSCOPE_POLISH_MODEL, polishMessages(raw, context, style), { temperature: 0.2, timeoutMs: 20_000 });
    } else if (orKey) {
      polished = await openrouterChat(orKey, POLISH_MODEL, polishMessages(raw, context, style), { temperature: 0.2, reasoningOff: true, timeoutMs: 30_000 });
    }
    // The model may answer instead of clean; acceptPolish decides, and keeps
    // the user's own words when it did. See server/transcribe-polish.ts.
    if (acceptPolish(raw, polished)) text = polished;
  } catch {
    // keep raw
  }

  return NextResponse.json({ text, raw });
}
