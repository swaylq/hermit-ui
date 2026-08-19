// One DashScope chat/completions call (OpenAI-compatible), shared by the two
// halves of voice input: the batch route (/api/transcribe) and the realtime
// socket (server/asr-stream.ts).
//
// Extracted from the route because asr-stream needs the identical call for its
// per-sentence polish, and a second copy would drift. Deliberately importless
// beyond a type: asr-stream is reached from `server.ts`, which runs under tsx
// where the `@/` path alias does NOT resolve — anything this file pulled in that
// used `@/…` would take the whole server down at boot.

import type { ORMessage } from './openrouter';

// Default https://dashscope.aliyuncs.com — the China/Beijing endpoint. A Model
// Studio workspace uses its own https://<ws>.<region>.maas.aliyuncs.com host;
// Alibaba Cloud International is https://dashscope-intl.aliyuncs.com.
export const DASHSCOPE_BASE_URL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com';

export async function dashscopeChat(
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
