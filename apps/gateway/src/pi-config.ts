// Machine-level pi runtime config, as edited on the dashboard's
// Settings → Pi Runtime page and stored in Machine.piConfig.
//
// The gateway polls the dashboard for it (cache with a short TTL) and merges it
// over the legacy .env knobs (HERMIT_PI_*), so a machine that hasn't configured
// anything keeps working exactly as before. The dashboard config wins when set.

import { api } from './api';

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
