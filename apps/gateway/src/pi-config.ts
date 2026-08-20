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
   * first entry of `models` — see credentialDefaultModel.
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
 * Promote the legacy .env endpoint into the machine's credential catalog, once.
 *
 * The two have been layered since pi shipped, and a machine configured entirely
 * by HERMIT_PI_* renders an EMPTY settings page — every field a grey example
 * instead of what the machine is actually running. That is not cosmetic: the
 * examples name models, so a blank page reads as "everything defaults to
 * claude-opus-5" when the machine is really on hyqubit with three models from a
 * file nobody is looking at. Reported as exactly that confusion.
 *
 * Now it writes a credential AND the pi backend built on it, because a
 * credential alone is not something you can start a chat on. Deliberately
 * conservative:
 *
 *  - Only when the catalog is empty. A machine configured on the page is never
 *    overwritten, and this becomes a no-op forever after.
 *  - Only when the env actually declares an endpoint.
 *  - A failure is logged and dropped. Seeding is a convenience; a dashboard blip
 *    must not stop sessions from spawning, which is why nothing awaits it.
 */
export async function seedPiConfigFromEnv(): Promise<void> {
  const env = envFallback();
  if (!env.provider || !env.baseUrl) return; // nothing to promote — cheap early out

  let existing: ModelCredential[] = [];
  try {
    existing = await getModelCredentials(true);
  } catch (e) {
    console.warn('[pi-config] seed: could not read the catalog:', (e as Error).message);
    return;
  }
  const plan = planCredentialSeed(env, existing);
  if (!plan) return;

  try {
    await api.setModelCredentials([plan.credential]);
    await api.addBackendInstance(plan.instance);
    credCache = null;
    console.log(`[pi-config] seeded Settings → Models from .env (provider "${env.provider}")`);
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
export function planCredentialSeed(
  env: PiConfig,
  existing: ModelCredential[],
): { credential: ModelCredential; instance: Record<string, unknown> } | null {
  if (!env.provider || !env.baseUrl) return null;
  if (existing.length > 0) return null; // already configured on the page

  const id = env.provider.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
  const credential: ModelCredential = {
    id,
    label: env.provider,
    provider: env.provider,
    api: env.api ?? 'anthropic-messages',
    baseUrl: env.baseUrl,
    models: env.models ?? [],
    ...(env.defaultModel?.trim() || env.models?.[0] ? { defaultModel: env.defaultModel?.trim() || env.models?.[0] } : {}),
    secretKey: env.secretKey ?? null,
  };
  return {
    credential,
    instance: { id: `pi-${id}`, harness: 'pi-rpc', credentialId: id, label: `pi · ${env.provider}` },
  };
}

function mergeRemote(remote: PiConfig | null): PiConfig {
  const env = envFallback();
  if (!remote) return env;
  return {
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


// ── The model-credential catalog ────────────────────────────────────────────
//
// A credential is one endpoint plus the NAME of the secret that authenticates
// to it. Backends reference one by id, and the dashboard resolves that id onto
// the session before the gateway ever sees it — so all this layer does is keep
// a short-TTL copy of the catalog and hand back the entry a session asked for.
//
// See docs/backends-and-models-design.md.

export type ModelCredential = {
  id: string;
  label: string;
  provider: string;
  api: string;
  baseUrl: string;
  models: string[];
  defaultModel?: string;
  secretKey?: string | null;
  modelLimits?: Record<string, ModelLimits>;
};

let credCache: ModelCredential[] | null = null;
let credFetched = 0;

/**
 * The machine's credentials, cached for the same TTL as the pi config.
 *
 * A failed poll keeps the previous list rather than erroring: a dashboard blip
 * must never stop a session from spawning, and an empty list would look exactly
 * like "this machine has no credentials", which is a different and much worse
 * answer.
 */
export async function getModelCredentials(force = false): Promise<ModelCredential[]> {
  if (!force && credCache && Date.now() - credFetched < TTL_MS) return credCache;
  try {
    const remote = (await api.pollRuntimeConfig()) as { credentials?: ModelCredential[] } | null;
    if (Array.isArray(remote?.credentials)) {
      credCache = remote.credentials;
      credFetched = Date.now();
    }
  } catch (e) {
    console.warn('[pi-config] pollRuntimeConfig failed, using cached credentials:', (e as Error).message);
  }
  return credCache ?? [];
}

/**
 * One credential by id.
 *
 * An id that names nothing falls back to the FIRST credential rather than to
 * nothing. That covers the window where a dashboard has been upgraded and a
 * gateway has not — the session arrives with no credential id at all — and it
 * covers a credential deleted out from under a live session. Both are better
 * served by the machine's one obvious endpoint than by an unauthenticated
 * child that 401s at the first turn.
 */
export async function getCredential(id?: string | null): Promise<ModelCredential | null> {
  const all = await getModelCredentials();
  if (all.length === 0) {
    // Nothing in the catalog: fall back to the legacy single-endpoint config,
    // which is what an un-migrated machine still has.
    const legacy = await getPiConfig();
    if (!legacy.provider || !legacy.baseUrl) return null;
    return {
      id: 'legacy', label: legacy.provider, provider: legacy.provider,
      api: legacy.api ?? 'anthropic-messages', baseUrl: legacy.baseUrl,
      models: legacy.models ?? [], defaultModel: legacy.defaultModel,
      secretKey: legacy.secretKey ?? null, modelLimits: legacy.modelLimits,
    };
  }
  return all.find((c) => c.id === id) ?? all[0] ?? null;
}

/**
 * The model a session on this credential gets when it pins none of its own.
 *
 * Explicit setting first, then the head of the models list. The list is ordered
 * by preference on the settings page, so its first entry is the credential's
 * "best" model. Returns undefined when neither is set, which leaves the harness
 * to pick — inventing a model id here would name something the provider may not
 * serve.
 *
 * Structurally typed rather than taking a whole ModelCredential: it reads two
 * fields, and the callers that have only those two should not have to fake the
 * rest.
 */
export function credentialDefaultModel(
  c: { defaultModel?: string; models?: string[] } | null | undefined,
): string | undefined {
  return c?.defaultModel?.trim() || c?.models?.[0]?.trim() || undefined;
}
