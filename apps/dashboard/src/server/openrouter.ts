// One OpenRouter chat/completions call. Extracted from api/transcribe so the
// voice pipeline and session auto-titling share a single client instead of two
// copies drifting apart.

export type ORMessage = { role: 'system' | 'user' | 'assistant'; content: unknown };

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function openrouterChat(
  apiKey: string,
  model: string,
  messages: ORMessage[],
  opts: {
    temperature?: number;
    reasoningOff?: boolean;
    /**
     * Some models refuse `reasoning: { enabled: false }` outright — Gemini 3.7
     * Flash answers HTTP 400 "Reasoning is mandatory for this endpoint and
     * cannot be disabled". For those, ask for the cheapest thinking there is
     * instead of none.
     */
    reasoningEffort?: 'low' | 'medium' | 'high';
    timeoutMs: number;
    title?: string;
  }
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const body: Record<string, unknown> = { model, messages };
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.reasoningOff) body.reasoning = { enabled: false };
    else if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://dash.swaylab.ai',
        'X-Title': opts.title ?? 'hermit-ui',
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
