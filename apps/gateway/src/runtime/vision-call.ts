// One local image → OCR text + layout description, over any OpenAI-compatible
// chat-completions endpoint that accepts `image_url` parts.
//
// Deliberately free of config, env and dashboard access, because it has two
// callers in two different processes: the gateway (`vision.ts`, config from the
// dashboard) and the hermit pi extension (config from the env its parent set).
// Those two carried separate copies of this call and drifted — the child ignored
// the configured prompt entirely, only ever ran a single pass on OpenRouter, and
// defaulted to a different model than the one the settings page showed.

import { readFile } from 'node:fs/promises';

export type VisionProvider = 'dashscope' | 'openrouter';

const ENDPOINTS: Record<VisionProvider, string> = {
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

/**
 * Per-provider default models. Both are Qwen-VL on purpose.
 *
 * Measured on a real dashboard screenshot (2026-08-06): qwen3-vl-32b
 * transcribed the Chinese install banner in full, while gemini-2.5-flash-lite
 * dropped it and scrambled the reading order. The fleet's screenshots are
 * Chinese-language UIs, so that difference is the whole point of the feature.
 */
export const VISION_DEFAULTS: Record<VisionProvider, { ocr: string; describe: string }> = {
  dashscope: { ocr: 'qwen-vl-ocr', describe: 'qwen-vl-max' },
  openrouter: { ocr: 'qwen/qwen3-vl-32b-instruct', describe: 'qwen/qwen3-vl-32b-instruct' },
};

export const OCR_PROMPT = '提取这张图片里的全部文字，逐行输出，不要描述布局。';
export const DESCRIBE_PROMPT =
  '列出这张图片（手机/桌面截图）里所有可见的文字，并描述界面布局：顶部标题、状态栏、各区块位置和内容。';

// A layout description of an ordinary dashboard screenshot ran to ~1200 output
// tokens; the previous 800 cap cut it off mid-sentence.
const MAX_TOKENS = 2000;
// The describe pass measured ~17s on qwen3-vl-32b. 60s left no headroom for a
// busy provider, and a truncated call costs the same as a completed one.
const TIMEOUT_MS = 90_000;
const MAX_BYTES = 6 * 1024 * 1024;

export type VisionResult = {
  provider: string;
  /** Raw text layer — best-effort, may be empty if that pass failed. */
  ocr: string;
  /** Layout/semantic description — best-effort. */
  description: string;
  /** Set only when the result is unusable, or to explain a half-empty one. */
  error?: string;
};

export type VisionOptions = {
  provider: VisionProvider;
  apiKey: string;
  filePath: string;
  /** Overrides for VISION_DEFAULTS; blank falls back. */
  ocrModel?: string;
  describeModel?: string;
  /** Overrides DESCRIBE_PROMPT for the description pass only. */
  prompt?: string;
};

function mimeOf(filePath: string): string {
  const p = filePath.toLowerCase();
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

async function readImage(filePath: string): Promise<{ b64: string; mime: string }> {
  const buf = await readFile(filePath);
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`image too large for vision: ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB (max 6MB)`);
  }
  return { b64: buf.toString('base64'), mime: mimeOf(filePath) };
}

async function callVision(opts: {
  provider: VisionProvider;
  apiKey: string;
  model: string;
  prompt: string;
  b64: string;
  mime: string;
}): Promise<string> {
  const r = await fetch(ENDPOINTS[opts.provider], {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
      // OpenRouter attributes usage to these when present; both are optional and
      // ignored by DashScope.
      ...(opts.provider === 'openrouter'
        ? { 'HTTP-Referer': 'https://dash.swaylab.ai', 'X-Title': 'hermit' }
        : {}),
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: MAX_TOKENS,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${opts.mime};base64,${opts.b64}` } },
          { type: 'text', text: opts.prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${opts.model} → ${r.status}: ${text.slice(0, 200)}`);
  return String(JSON.parse(text)?.choices?.[0]?.message?.content ?? '');
}

/**
 * OCR + describe one image. Never throws: a vision outage must not block message
 * delivery, so every failure comes back in `error` with whatever did succeed.
 *
 * The two passes run concurrently and are the same shape on both providers —
 * OpenRouter used to run a single call and copy its output into both fields,
 * which rendered downstream as the same paragraph printed twice under two
 * different headings.
 */
export async function runVision(opts: VisionOptions): Promise<VisionResult> {
  const defaults = VISION_DEFAULTS[opts.provider] ?? VISION_DEFAULTS.openrouter;
  const ocrModel = opts.ocrModel?.trim() || defaults.ocr;
  const describeModel = opts.describeModel?.trim() || defaults.describe;

  let img: { b64: string; mime: string };
  try {
    img = await readImage(opts.filePath);
  } catch (e) {
    return { provider: opts.provider, ocr: '', description: '', error: msg(e) };
  }

  const [ocr, description] = await Promise.allSettled([
    callVision({ ...opts, provider: opts.provider, model: ocrModel, prompt: OCR_PROMPT, ...img }),
    callVision({
      ...opts, provider: opts.provider, model: describeModel,
      prompt: opts.prompt?.trim() || DESCRIBE_PROMPT, ...img,
    }),
  ]);

  const ocrText = ocr.status === 'fulfilled' ? ocr.value.trim() : '';
  const descText = description.status === 'fulfilled' ? description.value.trim() : '';

  // Only surface an error when it explains something the caller can act on: one
  // pass failing is worth saying, both failing is the whole result.
  const failures = [
    ocr.status === 'rejected' ? `OCR: ${msg(ocr.reason)}` : null,
    description.status === 'rejected' ? `描述: ${msg(description.reason)}` : null,
  ].filter(Boolean);

  return {
    provider: opts.provider,
    ocr: ocrText,
    description: descText,
    error: failures.length > 0 ? failures.join(' | ').slice(0, 400) : undefined,
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The recognised image as text for a model that cannot see it.
 *
 * Shared so the injected prompt and the describe_image tool result read the
 * same. Empty sections are omitted rather than printed as "（无）" — a
 * single-model provider leaves one of them blank by design, and a placeholder
 * there reads as "the OCR found nothing", which is a different claim.
 */
export function formatVision(r: VisionResult, filePath: string): string {
  const parts: string[] = [];
  if (r.ocr) parts.push(`【OCR 文字】\n${r.ocr}`);
  if (r.description && r.description !== r.ocr) parts.push(`【布局描述】\n${r.description}`);
  if (parts.length === 0) {
    return `[图片识别没有返回内容${r.error ? `：${r.error}` : ''}。原图在 ${filePath}]`;
  }
  const head = `[上传的截图识别结果 — 原图缓存于 ${filePath}，如需放大细节可用 describe_image 工具复查]`;
  const tail = r.error ? `\n\n（部分识别失败：${r.error}）` : '';
  return `${head}\n${parts.join('\n\n')}${tail}`;
}
