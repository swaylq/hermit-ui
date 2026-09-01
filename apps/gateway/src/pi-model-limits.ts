// Context and output limits for the models a machine's provider serves.
//
// pi and omp both resolve a model's window from their bundled catalog, but that
// catalog is keyed by PROVIDER as well as by model id — `claude-opus-5` is
// listed under anthropic, openrouter, vercel-ai-gateway and a dozen more. A
// machine on a relay names its own provider (Settings → Pi Runtime: `hyqubit`,
// `litellm`, whatever it is called), so no catalog entry matches and both
// engines fall back to their unknown-model defaults: a 128,000-token window and
// a 16,384-token output cap (pi-coding-agent/src/config/model-registry.ts).
//
// For a 1M-context model that is not a cosmetic mislabel. Each request's
// `max_tokens` is sized against the window the engine believes in, so once a
// prompt passes ~124k the output budget collapses to a few dozen tokens and the
// reply arrives truncated mid-sentence with `stop_reason: max_tokens` — which
// reads, from the dashboard, exactly like the connection dropped. Measured on
// macmini001 on 2026-08-11: three truncations inside two hours, one of them
// capped at a single token, every one with a prompt in the 123.8k–128.4k band,
// while the same relay had already served a 383k-token prompt without
// complaint.
//
// So the generated model config states the limits outright rather than leaving
// the engine to guess. A model this table has never heard of gets nothing —
// exactly today's behaviour — and a machine serving one can name its limits in
// `piConfig.modelLimits`, which wins over the table.

export type ModelLimits = { contextWindow?: number; maxTokens?: number };

/**
 * Known model families, longest matching prefix wins.
 *
 * The numbers are pi's own catalog (`@oh-my-pi/pi-catalog` models.json, under
 * `anthropic`), so a model declared on a relay ends up with the same limits it
 * would have had under its real vendor. Prefix rather than exact id so dated
 * releases (`claude-opus-5-20260514`) and a relay's own suffixes still resolve.
 */
const FAMILIES: ReadonlyArray<{ prefix: string; contextWindow: number; maxTokens: number }> = [
  { prefix: 'claude-opus-5', contextWindow: 1_000_000, maxTokens: 128_000 },
  { prefix: 'claude-sonnet-5', contextWindow: 1_000_000, maxTokens: 128_000 },
  { prefix: 'claude-fable-5', contextWindow: 1_000_000, maxTokens: 128_000 },
  { prefix: 'claude-mythos-5', contextWindow: 1_000_000, maxTokens: 128_000 },
  { prefix: 'claude-haiku-4-5', contextWindow: 200_000, maxTokens: 64_000 },
  // The Kimi Code subscription's models. Not from pi's catalog — from the
  // kimi-code credential's own modelLimits (Settings → Models), duplicated here
  // so a credential that names none still spawns kimi with the right
  // KIMI_MODEL_MAX_CONTEXT_SIZE; the CLI's own fallback is 262,144 for every
  // env model, which would compact a k3 session at a quarter of its window.
  // Longest prefix first so `k3-256k` is not shadowed by `k3`.
  { prefix: 'k3-256k', contextWindow: 262_144, maxTokens: 131_072 },
  { prefix: 'kimi-for-coding', contextWindow: 262_144, maxTokens: 131_072 },
  { prefix: 'k3', contextWindow: 1_048_576, maxTokens: 131_072 },
];

/** A relay may expose `anthropic/claude-opus-5`; it is the same model. */
function bareId(id: string): string {
  const slash = id.lastIndexOf('/');
  return (slash === -1 ? id : id.slice(slash + 1)).trim();
}

/**
 * Overrides arrive from a Json column, so they are `unknown` in practice: a 0, a
 * negative, a string, a null. Any of those pinned as a window would be worse
 * than the guess this exists to replace, so only a finite positive number counts
 * — the same guard pi applies to windows reported by model discovery.
 */
function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/**
 * Limits to declare for `id`, or an empty object when nothing is known — the
 * caller then writes no limit fields at all and the engine keeps its own
 * default, rather than being handed a number this file invented.
 */
export function modelLimitsFor(id: string, overrides?: Record<string, ModelLimits> | null): ModelLimits {
  const bare = bareId(id);
  const family = FAMILIES.filter((f) => bare.startsWith(f.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  )[0];

  // Keyed by whatever the machine wrote: the id as configured, or the bare one.
  const override = overrides?.[id] ?? overrides?.[bare];

  const contextWindow = positive(override?.contextWindow) ?? family?.contextWindow;
  const maxTokens = positive(override?.maxTokens) ?? family?.maxTokens;

  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
}
