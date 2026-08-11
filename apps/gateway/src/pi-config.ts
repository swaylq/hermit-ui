// Machine-level pi runtime config, as edited on the dashboard's
// Settings → Pi Runtime page and stored in Machine.piConfig.
//
// The gateway polls the dashboard for it (cache with a short TTL) and merges it
// over the legacy .env knobs (HERMIT_PI_*), so a machine that hasn't configured
// anything keeps working exactly as before. The dashboard config wins when set.

import { api } from './api';
import type { ModelLimits } from './pi-model-limits';

export type PiImageConfig = {
  enabled?: boolean;
  provider?: 'dashscope' | 'openrouter' | 'none';
  /** Name of the secret in the encrypted store holding the vision API key. */
  apiKeySecret?: string | null;
  ocrModel?: string;
  describeModel?: string;
  prompt?: string;
};

export type PiConfig = {
  /**
   * 'api-key' (default) uses `provider`+`secretKey` below; 'cc-subscription'
   * reuses this machine's Claude Code Keychain OAuth credentials instead — no
   * API key needed, the anthropic provider is pi's built-in.
   */
  authMode?: 'api-key' | 'cc-subscription';
  provider?: string;
  baseUrl?: string;
  api?: string;
  models?: string[];
  /**
   * Per-model context window / output cap, keyed by model id, for a model
   * pi-model-limits has never heard of. Known families need no entry here — the
   * generated model config already states their real limits. Only set this when
   * the machine serves something the table does not cover, or when the relay's
   * window genuinely differs from the vendor's.
   */
  modelLimits?: Record<string, ModelLimits>;
  /**
   * Model for a pi session that pins none of its own. Blank falls back to the
   * first entry of `models` — see resolveDefaultModel.
   */
  defaultModel?: string;
  /** Secret-store name for the provider API key (never the value). */
  secretKey?: string | null;
  image?: PiImageConfig;
};

let cache: PiConfig | null = null;
let lastFetched = 0;
const TTL_MS = 30_000;

/** .env fallback — the pre-dashboard-config behaviour, unchanged. */
function envFallback(): PiConfig {
  const id = process.env.HERMIT_PI_PROVIDER?.trim();
  if (!id) return {};
  return {
    provider: id,
    baseUrl: process.env.HERMIT_PI_BASE_URL?.trim(),
    api: process.env.HERMIT_PI_API?.trim() || 'anthropic-messages',
    models: (process.env.HERMIT_PI_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean),
    defaultModel: process.env.HERMIT_PI_DEFAULT_MODEL?.trim() || undefined,
    secretKey: process.env.HERMIT_PI_SECRET?.trim() || null,
  };
}

/**
 * Copy the legacy .env endpoint knobs into the dashboard's config, once.
 *
 * The two have been layered since pi shipped: `mergeRemote` falls back to
 * HERMIT_PI_* for anything the dashboard leaves blank, so a machine configured
 * entirely by .env works — but its Settings → Pi Runtime page renders *empty*,
 * every field showing a grey example instead of what the machine is actually
 * running. That is not a cosmetic gap: the page's example values happen to name
 * models, so a blank page reads as "everything defaults to claude-opus-5" when
 * the machine is really on hyqubit with three models from a file nobody is
 * looking at. Reported as exactly that confusion.
 *
 * So the env values are promoted into the DB the first time a gateway starts
 * without them, after which the settings page is the single source of truth and
 * .env is only bootstrap. Deliberately conservative:
 *
 *  - Only when the stored config names no provider. A machine configured on the
 *    page is never overwritten, and this becomes a no-op forever after.
 *  - Only fields the env actually declares; the stored image/auth settings are
 *    carried through untouched.
 *  - A failure is logged and dropped. Seeding is a convenience; a dashboard blip
 *    must not stop pi sessions from spawning, which is why nothing awaits it.
 */
export async function seedPiConfigFromEnv(): Promise<void> {
  const env = envFallback();
  if (!env.provider || !env.baseUrl) return; // nothing to promote — cheap early out

  let remote: PiConfig | null = null;
  try {
    remote = (await api.pollPiConfig()) as PiConfig | null;
  } catch (e) {
    console.warn('[pi-config] seed: could not read current config:', (e as Error).message);
    return;
  }

  const next = planPiConfigSeed(env, remote);
  if (!next) return;

  try {
    await api.setPiConfig(next);
    cache = null; // force the next getPiConfig to see what we just wrote
    console.log(`[pi-config] seeded Settings → Pi Runtime from .env (provider "${env.provider}")`);
  } catch (e) {
    console.warn('[pi-config] seed: write failed:', (e as Error).message);
  }
}

/**
 * What (if anything) the seed should write. Null means leave it alone.
 *
 * Split out so the rules are what the tests exercise, rather than a local copy
 * of them — see the singleFlight note in pi-rpc.ts for what a re-implemented
 * guard costs.
 */
export function planPiConfigSeed(env: PiConfig, remote: PiConfig | null): PiConfig | null {
  if (!env.provider || !env.baseUrl) return null;
  if (remote?.provider?.trim()) return null; // already configured on the page

  return {
    ...(remote ?? {}),
    provider: env.provider,
    baseUrl: env.baseUrl,
    api: env.api,
    models: env.models?.length ? env.models : remote?.models,
    secretKey: remote?.secretKey || env.secretKey || null,
    defaultModel: remote?.defaultModel?.trim() || env.models?.[0],
  };
}

/**
 * The model a pi session gets when it pins none of its own.
 *
 * Explicit setting first, then the head of the models list. The list is ordered
 * by preference on the settings page, so its first entry is the machine's
 * "best" model — on this fleet that is claude-opus-5. Returns undefined when
 * nothing is configured, which leaves pi to pick, because inventing a model id
 * here would name something the machine's provider may not serve.
 */
export function resolveDefaultModel(cfg: PiConfig): string | undefined {
  return cfg.defaultModel?.trim() || cfg.models?.[0]?.trim() || undefined;
}

function mergeRemote(remote: PiConfig | null): PiConfig {
  const env = envFallback();
  if (!remote) return env;
  return {
    authMode: remote.authMode || 'api-key',
    provider: remote.provider?.trim() || env.provider,
    baseUrl: remote.baseUrl?.trim() || env.baseUrl,
    api: remote.api?.trim() || env.api || 'anthropic-messages',
    models: (remote.models?.length ? remote.models : env.models),
    modelLimits: remote.modelLimits,
    defaultModel: remote.defaultModel?.trim() || env.defaultModel,
    secretKey: remote.secretKey || env.secretKey,
    image: remote.image?.provider && remote.image.provider !== 'none' ? remote.image : undefined,
  };
}

/**
 * Current resolved pi config. Refreshes from the dashboard at most once per
 * TTL; a failed fetch keeps the previous cache (or the env fallback) rather
 * than erroring — a dashboard blip must never kill pi spawns.
 */
export async function getPiConfig(force = false): Promise<PiConfig> {
  if (!force && cache && Date.now() - lastFetched < TTL_MS) return cache;
  let remote: PiConfig | null = null;
  try {
    remote = (await api.pollPiConfig()) as PiConfig | null;
  } catch (e) {
    console.warn('[pi-config] pollPiConfig failed, using cached/env config:', (e as Error).message);
  }
  const next = mergeRemote(remote);
  if (remote !== null || !cache) {
    // Cache the merged result whenever we either got a fresh answer or have
    // nothing better yet. A transient poll failure after a good cache keeps the
    // good cache (we only overwrite cache with a successful merge or the first
    // attempt).
    if (remote !== null) {
      cache = next;
      lastFetched = Date.now();
    } else if (!cache) {
      cache = next;
      lastFetched = Date.now();
    }
  }
  return cache ?? next;
}
