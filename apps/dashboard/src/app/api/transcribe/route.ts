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
// Polish cleans the dictation into fluent, correct written text — fix ASR errors
// (typos, misheard zh/en tech terms, spoken symbols), drop spoken noise (fillers,
// repeats, redundancy), mend broken sentences, arrange an explicitly-dictated
// list — WITHOUT ever losing information/meaning, adding content, or answering a
// spoken question. The prompt, the fence that makes the transcript data rather
// than instruction, and the guard that catches the model answering anyway all
// live in server/transcribe-polish.ts. On failure we keep raw.
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
import { POLISH_SYSTEM, fenceTranscript, acceptPolish } from '@/server/transcribe-polish';

const ASR_MODEL = process.env.OPENROUTER_ASR_MODEL || 'mistralai/voxtral-small-24b-2507';
const POLISH_MODEL = process.env.OPENROUTER_POLISH_MODEL || 'deepseek/deepseek-v4-flash';

const DASHSCOPE_BASE_URL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com';
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
function orAsrMessages(base64: string): ORMessage[] {
  return [
    { role: 'system', content: ASR_SYSTEM },
    { role: 'user', content: [
      { type: 'text', text: '转写这段音频。' },
      { type: 'input_audio', input_audio: { data: base64, format: 'wav' } },
    ] },
  ];
}

// Polish messages (text in → cleaned text out); shared by both providers.
function polishMessages(raw: string): ORMessage[] {
  return [
    { role: 'system', content: POLISH_SYSTEM },
    { role: 'user', content: fenceTranscript(raw) },
  ];
}

// One DashScope chat/completions call (OpenAI-compatible), for the polish step.
async function dashscopeChat(
  apiKey: string,
  model: string,
  messages: ORMessage[],
  opts: { temperature?: number; timeoutMs: number },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const body: Record<string, unknown> = { model, messages };
    if (opts.temperature != null) body.temperature = opts.temperature;
    const r = await fetch(`${DASHSCOPE_BASE_URL}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const j = (await r.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string }; message?: string; code?: string }
      | null;
    if (!r.ok) throw new Error(`DashScope ${model} HTTP ${r.status}: ${j?.error?.message ?? j?.message ?? j?.code ?? 'unknown'}`);
    return (j?.choices?.[0]?.message?.content ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

// Direct DashScope qwen3-asr-flash (OpenAI-compatible). Differs from OpenRouter:
// the audio is a data-URI in input_audio.data, and asr_options sits at the body
// TOP LEVEL (per Alibaba's docs + Keyo's live testing — nesting it elsewhere is
// silently dropped). A dedicated ASR needs no system prompt; language omitted →
// auto (Chinese/English mix).
async function transcribeViaDashScope(apiKey: string, wavBase64: string, timeoutMs = 30_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${DASHSCOPE_BASE_URL}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DASHSCOPE_ASR_MODEL,
        messages: [
          { role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wavBase64}` } }] },
        ],
        asr_options: { enable_itn: false },
      }),
      signal: controller.signal,
    });
    const j = (await r.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string }; message?: string; code?: string }
      | null;
    if (!r.ok) throw new Error(`DashScope HTTP ${r.status}: ${j?.error?.message ?? j?.message ?? j?.code ?? 'unknown'}`);
    return (j?.choices?.[0]?.message?.content ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
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

  const base64 = Buffer.from(await wav.arrayBuffer()).toString('base64');

  // ① ASR — DashScope qwen3-asr-flash direct when its key is set (fast Keyo path);
  // its errors fall back to OpenRouter voxtral when possible. Fatal only if all fail.
  let raw: string;
  try {
    if (dsKey) {
      try {
        raw = await transcribeViaDashScope(dsKey, base64);
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
      polished = await dashscopeChat(dsKey, DASHSCOPE_POLISH_MODEL, polishMessages(raw), { temperature: 0.2, timeoutMs: 20_000 });
    } else if (orKey) {
      polished = await openrouterChat(orKey, POLISH_MODEL, polishMessages(raw), { temperature: 0.2, reasoningOff: true, timeoutMs: 30_000 });
    }
    // The model may answer instead of clean; acceptPolish decides, and keeps
    // the user's own words when it did. See server/transcribe-polish.ts.
    if (acceptPolish(raw, polished)) text = polished;
  } catch {
    // keep raw
  }

  return NextResponse.json({ text, raw });
}
