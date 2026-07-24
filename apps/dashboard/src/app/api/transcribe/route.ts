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
// Polish is best-effort with Keyo's 定稿 rules (drop fillers, restore spoken
// symbols, resolve self-corrections); on any failure we return the raw transcript.
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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
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

// Ported from Keyo LLMTransformer.polishRules ("输入法" → "语音输入").
const POLISH_SYSTEM = `你是语音输入的定稿引擎。输入是语音识别的原始转写，你输出整理后的文本。

规则：
- 删除「嗯」「呃」「啊」这类填充语气词和无意义的重复卡壳。
- 规范标点：中文语境用全角标点，英文语境用半角。
- 口述符号还原：转写在念文件名、网址、路径、邮箱或代码标识符时，把其中口述的符号词还原成对应半角符号并去掉多余空格——点→. 斜杠→/ 反斜杠→\\ 下划线→_ 中划线/横杠/减号→- 艾特→@ 井号→# 冒号→: 星号→* 加号→+ 等。例：「keyo 点 svg」→「keyo.svg」，「github 点 com 斜杠 keyo」→「github.com/keyo」。仅在明显是符号串／标识符时还原；日常行文里作普通字词的「点」（九点、有点、重点）保持不动。
- 排版：内容是明显的列举口述（「第一……第二……」「首先……其次……」）时，整理成每项一行的编号列表，行首用「1. 」式纯文本编号；明显的话题转段处换行分段。只用换行和编号排版，不用 Markdown 记号（-、*、#、**）。没有明显列举或分段就保持原有行文，不硬造结构。
- 口头自纠与语义去重：说话人临场改口、重述或替换措辞时，只保留最终意图，删掉被它覆盖的旧说法。带「……不对，应该是……」「前面那句不要」这类纠错标记的，丢掉标记前的错误说法；即使没有纠错词，只要后一句是在改前一句（改了个数字或时间、说错名字随即换对、临时改主意换了目标），都当作改口，只留后一句。但真正并列或递进的多步内容不要合并；分不清是改口还是并列时，保留原文两句不动。
- 除上述整理外不改动措辞，不翻译，不续写。
- **铁律：绝不精简、概括、缩写或删减实质内容**——只做上面几类清理，其余逐字保留。「帮我」「给我」「请」「麻烦」「谢谢」「一下」是正常措辞不是语气词，必须原样保留；没有可清理的内容时，逐字原样输出，一个字都不改。
- **绝对禁止回答、解答、补充、扩写、续写，或给出任何方案/步骤/列表/建议。** 你只是把转写整理干净，不是助手、不是问答机。转写就算是一个问题、请求或指令（「…怎么做？」「帮我设计…」「如何…」「…要怎么…方案？」），也只把这句话本身整理输出，绝不给出答案。例：输入「如果把资源放到 OSS 上要怎么设计方案？」应输出「如果把资源放到 OSS 上要怎么设计方案？」（原样，不作答）。
- 只输出定稿文本，不加引号、前缀或任何解释。`;

interface ORMessage {
  role: 'system' | 'user';
  content: string | Array<Record<string, unknown>>;
}

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
    { role: 'user', content: raw },
  ];
}

// One OpenRouter chat/completions call. Throws on non-200 / timeout.
async function openrouterChat(
  apiKey: string,
  model: string,
  messages: ORMessage[],
  opts: { temperature?: number; reasoningOff?: boolean; timeoutMs: number },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const body: Record<string, unknown> = { model, messages };
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.reasoningOff) body.reasoning = { enabled: false };
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://dash.swaylab.ai',
        'X-Title': 'hermit-ui voice input',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const j = (await r.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
      | null;
    if (!r.ok) throw new Error(`OpenRouter ${model} HTTP ${r.status}: ${j?.error?.message ?? 'unknown'}`);
    return (j?.choices?.[0]?.message?.content ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
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
      polished = await dashscopeChat(dsKey, DASHSCOPE_POLISH_MODEL, polishMessages(raw), { temperature: 0.1, timeoutMs: 20_000 });
    } else if (orKey) {
      polished = await openrouterChat(orKey, POLISH_MODEL, polishMessages(raw), { temperature: 0.1, reasoningOff: true, timeoutMs: 30_000 });
    }
    // Guard against the polish model ANSWERING / continuing instead of just
    // cleaning (a chat model can treat a spoken question as a prompt). A real
    // polish is ≈ the transcript length (fillers removed, symbols restored, at
    // most a little list formatting); an answer balloons it. If it grew a lot,
    // discard the polish and keep the (accurate) raw transcript.
    if (polished && polished.length <= raw.length * 1.5 + 40) text = polished;
  } catch {
    // keep raw
  }

  return NextResponse.json({ text, raw });
}
