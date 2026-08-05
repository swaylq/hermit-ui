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
import { execFile } from 'node:child_process';
import { getPiConfig } from '../pi-config';

const SECRET_BIN = path.join(os.homedir(), '.local', 'bin', 'secret');
const PROVIDER_RE = /^[A-Za-z0-9_-]+$/;

/** `openrouter` -> `OPENROUTER_API_KEY` */
export function envVarForProvider(provider: string): string {
  return `${provider.replace(/-/g, '_').toUpperCase()}_API_KEY`;
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
 * This machine's own model endpoint, if it declares one.
 *
 * pi honours ANTHROPIC_AUTH_TOKEN but NOT ANTHROPIC_BASE_URL, so a
 * self-hosted/proxied endpoint cannot be selected by environment alone. The
 * hermit extension registers it as a pi provider instead (pi.registerProvider),
 * and these values are what it registers.
 *
 * Config comes from the dashboard's Settings → Pi Runtime page (Machine.piConfig,
 * merged over the legacy gateway .env knobs), so it can be edited without
 * touching files. The key is passed as HERMIT_PI_API_KEY and referenced from
 * the provider registration as "$HERMIT_PI_API_KEY", so it never appears in a
 * config file.
 */
export async function machineProviderEnv(): Promise<Record<string, string>> {
  const cfg = await getPiConfig();
  const id = cfg.provider?.trim();
  const baseUrl = cfg.baseUrl?.trim();
  if (!id || !baseUrl) return {};

  const out: Record<string, string> = {
    HERMIT_PI_PROVIDER: id,
    HERMIT_PI_BASE_URL: baseUrl,
    HERMIT_PI_API: cfg.api?.trim() || 'anthropic-messages',
    HERMIT_PI_MODELS: (cfg.models ?? []).join(',') || '',
  };

  const secretName = cfg.secretKey?.trim();
  if (secretName && PROVIDER_RE.test(secretName.replace(/_/g, '-'))) {
    const value = await readSecret(secretName);
    if (value) out.HERMIT_PI_API_KEY = value;
  }
  return out;
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

  return {
    HERMIT_VISION_PROVIDER: img.provider,
    HERMIT_VISION_API_KEY: value,
    HERMIT_VISION_OCR_MODEL: img.ocrModel || (img.provider === 'dashscope' ? 'qwen-vl-ocr' : ''),
    HERMIT_VISION_DESCRIBE_MODEL: img.describeModel || (img.provider === 'dashscope' ? 'qwen-vl-max' : ''),
    ...(img.prompt ? { HERMIT_VISION_PROMPT: img.prompt } : {}),
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
  const name = envVarForProvider(provider);
  const value = await readSecret(name);
  return value ? { [name]: value } : {};
}
