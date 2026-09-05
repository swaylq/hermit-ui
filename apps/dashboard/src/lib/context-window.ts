// How big the context window is, per backend, so the bar has a real denominator.
//
// CtxBar has always divided by a hard-coded 1,000,000 — right for Claude Opus 5
// and wrong for anything else. On a codex session, whose window is 258,400, that
// renders a conversation at 60% occupancy as a comfortable 15% bar. The number
// under it was never wrong; the fraction was.
//
// Codex and kimi-code are corrected here. claude-tmux keeps 1M (it is right),
// and pi keeps it too — pi's real window varies per machine-configured model
// and the gateway already tracks that in pi-model-limits.ts, which has no
// route to the client. Fixing pi means plumbing that through, which is a
// separate change with its own blast radius; quietly guessing here would be
// the same class of bug this fixes.

/** Claude Opus 5's window, and the historical default for every backend. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Codex model -> usable context window, longest matching prefix wins.
 *
 * These are `context_window * effective_context_window_percent` as codex itself
 * reports them in ~/.codex/models_cache.json — 272,000 * 95% = 258,400, which is
 * exactly the `model_context_window` its rollout files record. Using the raw
 * 272,000 would under-read the bar by 5% at every point.
 *
 * Prefix rather than exact id so a dated or suffixed release (`gpt-5.6-sol-wm`)
 * resolves without an entry of its own.
 */
const CODEX_WINDOWS: ReadonlyArray<{ prefix: string; window: number }> = [
  // Ordered longest-first so `gpt-5.3-codex-spark` is not shadowed by a shorter
  // `gpt-5.3` entry if one is ever added above it.
  { prefix: 'gpt-5.3-codex-spark', window: 121_600 },
  // Same 272,000 * 95% as the 5.x families — verified against a gpt-6-astra
  // rollout on 2026-09-05, which records model_context_window 258,400. Listed
  // rather than left to the fallback because the fleet default landing on the
  // "model we have never heard of" branch reads like an oversight.
  { prefix: 'gpt-6', window: 258_400 },
  { prefix: 'gpt-5.6', window: 258_400 },
  { prefix: 'gpt-5.5', window: 258_400 },
  { prefix: 'gpt-5.4', window: 258_400 },
];

/**
 * What codex gets when it names a model this table has never heard of.
 *
 * Every generally-available codex model has shipped with the same 272k window,
 * so this is the informed guess rather than a shrug — and it is far closer than
 * the 1M default, which is the only other option.
 */
export const CODEX_DEFAULT_WINDOW = 258_400;

export function codexContextWindow(model: string | null | undefined): number {
  const id = (model ?? '').trim().toLowerCase();
  if (!id) return CODEX_DEFAULT_WINDOW;
  return CODEX_WINDOWS.find((m) => id.startsWith(m.prefix))?.window ?? CODEX_DEFAULT_WINDOW;
}

/**
 * Kimi Code model -> context window, longest matching prefix wins.
 *
 * The numbers are the credential's own modelLimits (Settings → Models), kept in
 * step by hand: k3 runs its real 1M window, the 256k variants would otherwise
 * read a genuinely full window as a quarter-full bar.
 */
const KIMI_WINDOWS: ReadonlyArray<{ prefix: string; window: number }> = [
  // Ordered longest-first so `k3-256k` is not shadowed by `k3`.
  { prefix: 'k3-256k', window: 262_144 },
  { prefix: 'kimi-for-coding', window: 262_144 },
  { prefix: 'k3', window: 1_048_576 },
];

/**
 * What kimi-code gets when it names a model this table has never heard of: the
 * CLI's own fallback. Without KIMI_MODEL_MAX_CONTEXT_SIZE the CLI assumes
 * 262,144 for every env-configured model and compacts there, so a wider bar
 * would be lying in the dangerous direction.
 */
export const KIMI_DEFAULT_WINDOW = 262_144;

export function kimiContextWindow(model: string | null | undefined): number {
  const id = (model ?? '').trim().toLowerCase();
  if (!id) return KIMI_DEFAULT_WINDOW;
  return KIMI_WINDOWS.find((m) => id.startsWith(m.prefix))?.window ?? KIMI_DEFAULT_WINDOW;
}

/**
 * The denominator for a session's context bar.
 *
 * dsh deliberately takes the default: its catalog (dsh-llm-deepseek) declares
 * 1M for both deepseek-v4 models, which is exactly DEFAULT_CONTEXT_WINDOW.
 */
export function contextWindowFor(
  runtime: string | null | undefined,
  model?: string | null,
): number {
  if (runtime === 'codex-exec') return codexContextWindow(model);
  if (runtime === 'kimi-code') return kimiContextWindow(model);
  return DEFAULT_CONTEXT_WINDOW;
}
