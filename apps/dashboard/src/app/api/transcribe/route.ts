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
// Polish is a faithful CORRECTOR (not an editor): fix ASR errors (typos, misheard
// zh/en tech terms, spoken symbols), format an explicitly-dictated list, but never
// add / omit meaning and never answer a spoken question. On any failure — or if it
// balloons past the transcript length (i.e. it started answering) — we keep raw.
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

// A faithful CORRECTOR: fix recognition errors + arrange an explicitly-dictated
// list; never add / omit meaning, never answer a question.
const POLISH_SYSTEM = `你是语音识别的「转写校正器」。输入是语音识别（ASR）的原始转写，可能有识别错误。你的任务是把它校正成用户实际说的内容——修识别错误、理顺已有结构，别的一律不动。

【最高优先·绝不作答】转写如果本身是一个问题、请求或指令（例如「…怎么做？」「要怎么设计方案？」「需要哪些步骤？」「帮我规划一下…」），你只把这句问题/请求本身校正后原样输出，绝对禁止回答它、生成方案/步骤/清单/建议。例：输入「如果把资源放到 OSS 上要怎么设计方案？」→ 输出「如果把资源放到 OSS 上要怎么设计方案？」（原样，不作答）。下面的「列表编排」绝不适用于问题/请求。

要做的校正：
- 错别字、同音字误识别：结合上下文改对。
- 中英混说、技术/编程语境被听错的词：积极还原成正确写法（把听成中文谐音的英文词、库名、框架、命令、专有名词、代码标识符改回去），如「阿森克」→async、「拍桑」→pandas、「麦色扣」→MySQL、「道克」→Docker、「给他哈波」→GitHub。这是修识别、不算改动内容，大胆改。
- 口述符号还原：念文件名、网址、路径、邮箱、代码标识符时，把口述的符号词还原成半角符号并去掉多余空格（点→. 斜杠→/ 下划线→_ 艾特→@ 井号→# 冒号→: 等），如「github 点 com 斜杠 keyo」→「github.com/keyo」；日常作普通字词的「点」（九点、有点、重点）不动。
- 规范标点（中文语境全角、英文语境半角）。
- 列表编排（仅当用户自己在逐条口述时）：用户明确在依次列举条目（说了「第一…第二…第三…」「首先…其次…最后…」「一是…二是…」，或「有几点／几步／几件事」并逐条说了）时，把这些条目整理成每项一行、行首用「1. 」式编号（并列无序的要点用「- 」），列举前的引语保留。理成列表必须一项不少、把用户原话搬进各项、不得增删。只有一句话、或只是随口的「先…然后…最后…」这种叙述性顺承，不算列举，保持原样别硬排。
  列表示例：输入「这个项目要做三件事，第一是搭后端接口，第二是写前端页面，第三是部署上线」→ 输出：
  这个项目要做三件事：
  1. 搭后端接口
  2. 写前端页面
  3. 部署上线
- 只删除纯粹的语气词、卡壳杂音（单独出现的「嗯」「呃」「啊」）。
- 明确改口时（说了「不对」「不是」「应该是」这类明确纠正词）：留最终说法、去掉被否定的旧值和纠正词。没有明确纠正词就不自行判断改口、原样保留。

铁律：绝不增加内容、绝不省略／精简／概括意思——校正字词、理顺结构 ≠ 删改内容，用户说的每一句、每一个并列项都要保留。只输出校正后的文本，不加引号、前缀或任何解释。`;

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
    // correcting (a chat model can treat a spoken question as a prompt). A real
    // correction is ≈ the transcript length (± a little list formatting); an
    // answer balloons it. If it grew a lot, discard it and keep the raw transcript.
    if (polished && polished.length <= raw.length * 1.5 + 40) text = polished;
  } catch {
    // keep raw
  }

  return NextResponse.json({ text, raw });
}
