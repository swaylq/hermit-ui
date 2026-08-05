// Image recognition for sessions whose model endpoint drops image blocks
// (hyqubit substitutes [Unsupported Image], so the model never sees the
// pixels). When enabled on Settings → Pi Runtime, the gateway describes
// dashboard uploads with a standalone vision model and injects the text into
// the prompt, and the pi extension exposes the same call as a describe_image
// tool for on-demand re-inspection.
//
// The API key is read from the machine's encrypted store at call time (never
// logged, never written to disk), exactly like the provider key.

import { readFile } from 'node:fs/promises';
import { readSecret } from './runtime/pi-credentials';
import { getPiConfig } from './pi-config';

export type DescribeResult = {
  provider: string;
  /** Raw text layer — best-effort, may be empty if the OCR model fails. */
  ocr: string;
  /** Layout/semantic description — best-effort. */
  description: string;
  error?: string;
};

const DASH_SCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_DESCRIBE_PROMPT =
  '列出这张图片（手机/桌面截图）里所有可见的文字，并描述界面布局：顶部标题、状态栏、各区块位置和内容。';

const HTTP_TIMEOUT_MS = 60_000;

/** Base64 a local image, guarding against anything huge (> 6MB). */
async function imageBase64(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  if (buf.byteLength > 6 * 1024 * 1024) {
    throw new Error(`image too large for vision: ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB`);
  }
  return buf.toString('base64');
}

async function chatCompletion(opts: {
  url: string;
  apiKey: string;
  model: string;
  prompt: string;
  imageB64: string;
  mime: string;
}): Promise<string> {
  const r = await fetch(opts.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.url.includes('openrouter.ai')
        ? { authorization: `Bearer ${opts.apiKey}` }
        : { authorization: `Bearer ${opts.apiKey}` }),
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${opts.mime};base64,${opts.imageB64}` } },
            { type: 'text', text: opts.prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${opts.model} → ${r.status}: ${text.slice(0, 160)}`);
  const data = JSON.parse(text);
  return data?.choices?.[0]?.message?.content ?? '';
}

/**
 * Recognise a local image via the machine's configured vision provider.
 * Returns best-effort OCR + description; any failure is captured in the result
 * rather than thrown, so a vision outage never blocks message delivery.
 */
export async function describeImage(filePath: string): Promise<DescribeResult> {
  const cfg = await getPiConfig();
  const img = cfg.image;
  if (!img?.enabled || !img.provider || img.provider === 'none') {
    return { provider: 'none', ocr: '', description: '' };
  }

  const secretName = img.apiKeySecret?.trim();
  if (!secretName) {
    return { provider: img.provider, ocr: '', description: '', error: 'no vision API key configured' };
  }
  const apiKey = await readSecret(secretName);
  if (!apiKey) {
    return { provider: img.provider, ocr: '', description: '', error: `secret "${secretName}" not found in store` };
  }

  try {
    const b64 = await imageBase64(filePath);
    const mime = filePath.toLowerCase().endsWith('.jpg') || filePath.toLowerCase().endsWith('.jpeg')
      ? 'image/jpeg'
      : filePath.toLowerCase().endsWith('.webp')
        ? 'image/webp'
        : 'image/png';

    if (img.provider === 'dashscope') {
      const [ocr, description] = await Promise.allSettled([
        chatCompletion({
          url: DASH_SCOPE_URL, apiKey, model: img.ocrModel || 'qwen-vl-ocr',
          prompt: '提取这张图片里的全部文字，逐行输出，不要描述布局。', imageB64: b64, mime,
        }),
        chatCompletion({
          url: DASH_SCOPE_URL, apiKey, model: img.describeModel || 'qwen-vl-max',
          prompt: img.prompt || DEFAULT_DESCRIBE_PROMPT, imageB64: b64, mime,
        }),
      ]);
      return {
        provider: 'dashscope',
        ocr: ocr.status === 'fulfilled' ? ocr.value.trim() : '',
        description: description.status === 'fulfilled' ? description.value.trim() : '',
        error: ocr.status === 'rejected' ? String(ocr.reason).slice(0, 200) : undefined,
      };
    }

    // openrouter (or any other chat-completions endpoint) — single model call.
    const model = img.ocrModel || 'openai/gpt-4o-mini';
    const description = await chatCompletion({
      url: OPENROUTER_URL, apiKey, model,
      prompt: img.prompt || DEFAULT_DESCRIBE_PROMPT, imageB64: b64, mime,
    });
    return { provider: 'openrouter', ocr: description, description };
  } catch (e) {
    return {
      provider: img.provider, ocr: '', description: '',
      error: e instanceof Error ? e.message.slice(0, 240) : String(e),
    };
  }
}
