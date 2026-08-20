// Provider credentials for pi sessions.
//
// pi reads `<PROVIDER>_API_KEY` from the environment, and the encrypted store
// already names keys the same way (OPENROUTER_API_KEY, DASHSCOPE_API_KEY, ...),
// so a provider name maps onto a secret name with no extra configuration.
//
// The key is fetched per session start and handed to the child process's env.
// It is never written to disk, never logged, and never placed on a command line
// — `secret` is invoked through execFile with no shell, the same way
// secrets.ts does it.

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { getPiConfig, getCredential } from '../pi-config';

const SECRET_BIN = path.join(os.homedir(), '.local', 'bin', 'secret');
const PROVIDER_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Built-in pi providers whose API key env var does NOT follow the
 * `<PROVIDER>_API_KEY` convention — mirror of pi's own env-api-keys map
 * (@earendil-works/pi-ai/dist/env-api-keys.js). The gateway must export the
 * SAME env var pi looks up, or the built-in provider cannot authenticate. The
 * secret-store name is the env var name, so e.g. a Kimi key is stored as
 * `MOONSHOT_API_KEY` and picked up by both this gateway and pi.
 */
const PROVIDER_ENV_OVERRIDES: Record<string, string> = {
  moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
  huggingface: 'HF_TOKEN',
};

/**
 * The env var pi expects for a provider — `openrouter` -> `OPENROUTER_API_KEY`,
 * but `moonshotai-cn` -> `MOONSHOT_API_KEY` (pi's built-in moonshot providers
 * all read MOONSHOT_API_KEY, see pi-ai env-api-keys.js).
 */
export function envVarForProvider(provider: string): string {
  return PROVIDER_ENV_OVERRIDES[provider] ?? `${provider.replace(/-/g, '_').toUpperCase()}_API_KEY`;
}

/** Read a secret by name from the machine's encrypted store. */
export function readSecret(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      SECRET_BIN,
      ['get', key],
      { timeout: 15_000, maxBuffer: 256 * 1024 },
      (err, stdout) => resolve(err ? null : stdout.replace(/\n$/, '') || null),
    );
    child.stdin?.end();
  });
}

/**
 * NOTE — the Claude Code subscription path used to live here.
 *
 * A machine could set `authMode: 'cc-subscription'` and every pi child would be
 * handed this host's Claude Code OAuth token through ANTHROPIC_OAUTH_TOKEN,
 * which triggered pi-ai's stealth-OAuth branch: the verbatim Claude Code
 * identity as system block 0, the claude-cli UA, the claude-code beta. It
 * worked — the responses came back `anthropic-ratelimit-unified-status:
 * allowed`, i.e. inside the plan rather than on extra usage.
 *
 * It is gone deliberately, not because it broke. Pointing pi (and then prime,
 * and then a third harness) at one Max account is exactly what the rate limits
 * and the request classifier exist to catch, and a single reclassification
 * would have taken the whole fleet's non-Claude backends down at once. Claude
 * Code keeps its own subscription, through its own tmux path, and nothing else
 * reaches for it. Removed with the Keychain reader, the SYSTEM.md writer and
 * the ANTHROPIC_OAUTH_TOKEN fingerprint key on 2026-08-21.
 */

/**
 * The env a child needs to reach ONE credential from Settings → Models.
 *
 * pi honours ANTHROPIC_AUTH_TOKEN but NOT ANTHROPIC_BASE_URL, so a
 * self-hosted/proxied endpoint cannot be selected by environment alone. The
 * hermit extension registers it as a provider instead (pi.registerProvider),
 * and these values are what it registers.
 *
 * The key is passed as HERMIT_PI_API_KEY and referenced from the provider
 * registration as "$HERMIT_PI_API_KEY", so it never appears in a config file.
 *
 * `credentialId` is the backend's own credential, resolved by the dashboard and
 * carried on the session. Omitted (or naming nothing) falls back to the first
 * credential the machine has — which is what a lagging caller, and the vision
 * path, still expect.
 */
async function computeMachineProviderEnv(credentialId?: string | null): Promise<Record<string, string>> {
  const cfg = await getCredential(credentialId);
  if (!cfg) return {};

  const id = cfg.provider?.trim();
  const baseUrl = cfg.baseUrl?.trim();
  // A credential with no endpoint is the marker for "this harness supplies its
  // own" (dsh against DeepSeek's own catalog). There is nothing to register,
  // but its key still has to reach the child, so the secret lookup below runs
  // either way.
  const out: Record<string, string> = {};
  if (id && baseUrl) {
    out.HERMIT_PI_PROVIDER = id;
    out.HERMIT_PI_BASE_URL = baseUrl;
    out.HERMIT_PI_API = cfg.api?.trim() || 'anthropic-messages';
    out.HERMIT_PI_MODELS = (cfg.models ?? []).join(',') || '';
  }

  const secretName = cfg.secretKey?.trim();
  if (secretName && PROVIDER_RE.test(secretName.replace(/_/g, '-'))) {
    const value = await readSecret(secretName);
    if (value) {
      out.HERMIT_PI_API_KEY = value;
      // Built-in providers read their own env var rather than the hermit one —
      // a Kimi key has to arrive as MOONSHOT_API_KEY or pi cannot see it.
      if (id && !baseUrl) out[envVarForProvider(id)] = value;
    }
  }
  return out;
}

/**
 * The env vars that actually authenticate a child, in the order they are hashed.
 *
 * Only credential-bearing names belong here. A base URL or a model list moving
 * is not a reason to recycle a live conversation.
 */
const AUTH_ENV_KEYS = ['HERMIT_PI_API_KEY'] as const;

/**
 * A stable, non-reversible fingerprint of the credentials in an env.
 *
 * Truncated SHA-256 per key. It exists to answer one question — "is this the
 * same credential the child booted with?" — and must never be able to answer
 * "what is it": these values reach logs and eviction reasons.
 *
 * Always applied to machineProviderEnv()'s output, never to a child's full env.
 * The two differ: a child inherits process.env, so a stray HERMIT_PI_API_KEY in
 * the gateway's own .env would appear on one side of the comparison and not the
 * other, and every check would read as "the credential rotated".
 */
export function fingerprintAuthEnv(env: Record<string, string>): string | null {
  const parts = AUTH_ENV_KEYS
    .filter((k) => env[k])
    .map((k) => `${k}:${createHash('sha256').update(env[k]).digest('hex').slice(0, 12)}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

// Last fingerprint observed PER CREDENTIAL, refreshed as a side effect of every
// machineProviderEnv() call so a boot and a later check can never disagree
// about what "current" means (see currentAuthFingerprint).
//
// Keyed, because a machine now has several credentials at once: one cache slot
// would report the last one resolved as "current" for every session, and a
// pi-on-hyqubit child would be evicted every time a prime-on-Kimi child booted.
const authFp = new Map<string, { at: number; value: string | null }>();

/**
 * Provider/auth env for a child, and the single place the fingerprint cache is
 * kept honest — boot resolves credentials through here, so the value it records
 * is by construction the value a later staleness check compares against.
 */
export async function machineProviderEnv(credentialId?: string | null): Promise<Record<string, string>> {
  const env = await computeMachineProviderEnv(credentialId);
  authFp.set(credentialId ?? '', { at: Date.now(), value: fingerprintAuthEnv(env) });
  return env;
}

/**
 * Fingerprint of the credentials a child would boot with *right now*.
 *
 * Cached, because the callers are on the message-delivery path and the
 * uncached form shells out to `secret`. A rotated key is picked up within the
 * window; a minute of staleness costs nothing and saves a subprocess per
 * message.
 */
export async function currentAuthFingerprint(
  credentialId?: string | null,
  maxAgeMs = 60_000,
): Promise<string | null> {
  const key = credentialId ?? '';
  const hit = authFp.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  await machineProviderEnv(credentialId);
  return authFp.get(key)?.value ?? null;
}

/**
 * Vision env for pi children — the values the hermit extension's
 * describe_image tool needs to recognise images with a standalone vision
 * model. Only set when image recognition is enabled, so a pi child that never
 * sees an image doesn't carry the key in its env.
 */
export async function visionEnv(): Promise<Record<string, string>> {
  const cfg = await getPiConfig();
  const img = cfg.image;
  if (!img?.enabled || !img.provider || img.provider === 'none') return {};
  const secretName = img.apiKeySecret?.trim();
  if (!secretName || !PROVIDER_RE.test(secretName.replace(/_/g, '-'))) return {};
  const value = await readSecret(secretName);
  if (!value) return {};

  // Only what was actually configured. The child falls back to VISION_DEFAULTS
  // for whatever is blank, so the two processes cannot disagree about the
  // default model — which they did: this used to send an empty string for
  // OpenRouter, and the child then invented `openai/gpt-4o-mini` on its own.
  return {
    HERMIT_VISION_PROVIDER: img.provider,
    HERMIT_VISION_API_KEY: value,
    ...(img.ocrModel?.trim() ? { HERMIT_VISION_OCR_MODEL: img.ocrModel.trim() } : {}),
    ...(img.describeModel?.trim() ? { HERMIT_VISION_DESCRIBE_MODEL: img.describeModel.trim() } : {}),
    ...(img.prompt?.trim() ? { HERMIT_VISION_PROMPT: img.prompt.trim() } : {}),
  };
}

/**
 * Build the env a pi child needs to authenticate.
 *
 * Returns an empty object when the provider is unset or the secret is missing —
 * pi then falls back to whatever the gateway's own environment carries, which
 * is what a machine with provider keys already exported would expect.
 */
export async function providerEnv(provider: string | null | undefined): Promise<Record<string, string>> {
  if (!provider || !PROVIDER_RE.test(provider)) return {};
  // envVarForProvider doubles as the secret name: for moonshotai-cn both the
  // store key and the child env var are MOONSHOT_API_KEY, so one lookup serves
  // both. (Custom machine endpoints stay on the old convention — their key is
  // passed through HERMIT_PI_API_KEY instead, see machineProviderEnv.)
  const name = envVarForProvider(provider);
  const value = await readSecret(name);
  return value ? { [name]: value } : {};
}
