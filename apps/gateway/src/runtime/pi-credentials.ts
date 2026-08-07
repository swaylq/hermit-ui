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
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { getPiConfig } from '../pi-config';

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
 * Claude Code OAuth access token from the macOS Keychain — the same credential
 * Claude Code itself uses (service "Claude Code-credentials", JSON payload
 * with claudeAiOauth.accessToken). Mirror of agent/anthropic_adapter.py's
 * keychain reader in Hermes.
 */
function readClaudeCodeKeychainToken(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 8_000, maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const data = JSON.parse(stdout);
          resolve(data?.claudeAiOauth?.accessToken ?? null);
        } catch {
          resolve(null);
        }
      },
    );
    child.stdin?.end();
  });
}

/**
 * pi 全局配置目录的干净 SYSTEM.md，cc-subscription 模式幂等写入。
 *
 * 这份文件的内容会成为 system 数组的第二个 block：pi-ai 的 stealth OAuth 分支
 * （apiKey 含 sk-ant-oat 时）会把 "You are Claude Code, Anthropic's official CLI
 * for Claude." 作为第一个 block 逐字前置（见 pi-ai anthropic-messages.js
 * buildParams），本文件只承载我们的指令。因此它绝不能含 pi/harness 身份段
 * （"operating inside pi" / "Pi documentation"），否则分类器会把它判成第三方
 * harness，拒掉订阅额度。不要删除用户已有的 SYSTEM.md —— 只在该模式下补一个
 * 干净版本（若已有则不动）。
 */
function ensureCleanSystemPrompt(): void {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const sysPath = path.join(agentDir, 'SYSTEM.md');
  if (existsSync(sysPath)) return; // 已有自定义 system prompt，尊重它
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      sysPath,
      [
        'You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.',
        '',
        'Guidelines:',
        '- Be concise in your responses',
        '- Show file paths clearly when working with files',
        '',
      ].join('\n'),
      'utf8',
    );
  } catch (e) {
    console.warn('[pi-credentials] 写入 SYSTEM.md 失败:', (e as Error).message);
  }
}
/**
 * The env that makes pi take its stealth-OAuth path for a Claude Code OAuth
 * token.
 *
 * MUST be ANTHROPIC_OAUTH_TOKEN, not ANTHROPIC_AUTH_TOKEN: pi's anthropic
 * provider resolves AUTH_TOKEN to a plain `Authorization: Bearer` header, which
 * bypasses the OAuth branch in pi-ai anthropic-messages.js entirely. That branch
 * only fires when the token reaches createClient as `apiKey` (it checks
 * `apiKey.includes("sk-ant-oat")`), and it is what adds the verbatim Claude Code
 * identity as system block 1, the claude-cli UA and x-app headers, and the
 * claude-code beta. Without it the request is classified as third-party and gets
 * a 429 rate_limit_error with no `anthropic-ratelimit-unified-status: allowed`
 * header — the exact failure this whole path exists to avoid.
 */
export function subscriptionTokenEnv(token: string): Record<string, string> {
  if (!token.includes('sk-ant-oat')) {
    console.warn(
      '[pi-credentials] cc-subscription: Keychain token 不含 sk-ant-oat，'
      + 'pi-ai 的 stealth OAuth 分支不会触发，请求会落 extra usage / 429（无 unified 头）',
    );
  }
  return { ANTHROPIC_OAUTH_TOKEN: token };
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
async function computeMachineProviderEnv(): Promise<Record<string, string>> {
  const cfg = await getPiConfig();

  // Claude Code 订阅模式：复用本机 Claude Code 的 Keychain OAuth 凭据，anthropic
  // 是 pi 内置 provider，无需注册也无需 API key。token 必须经 ANTHROPIC_OAUTH_TOKEN
  // 注入（见 subscriptionTokenEnv）：pi 把 AUTH_TOKEN 当普通 Bearer 头，只有
  // OAUTH_TOKEN 会触发 pi-ai 的 stealth OAuth 分支——system 第一块逐字带上 Claude
  // Code 身份行 + claude-cli UA，请求才进订阅桶（响应头 unified=allowed），否则
  // 429 无 unified 头。同时确保 pi 全局配置目录里有干净的 SYSTEM.md（system 第二块）。
  if (cfg.authMode === 'cc-subscription') {
    const token = await readClaudeCodeKeychainToken();
    if (!token) {
      console.warn('[pi-credentials] cc-subscription: 无法从 Keychain 读取 Claude Code 凭据，跳过订阅注入');
      return {};
    }
    ensureCleanSystemPrompt();
    return subscriptionTokenEnv(token);
  }

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
 * The env vars that actually authenticate a child, in the order they are hashed.
 *
 * Only credential-bearing names belong here. A base URL or a model list moving
 * is not a reason to recycle a live conversation.
 */
const AUTH_ENV_KEYS = ['ANTHROPIC_OAUTH_TOKEN', 'HERMIT_PI_API_KEY'] as const;

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

// Last fingerprint observed, refreshed as a side effect of every
// machineProviderEnv() call so a boot and a later check can never disagree
// about what "current" means (see currentAuthFingerprint).
let authFp: { at: number; value: string | null } = { at: 0, value: null };

/**
 * Provider/auth env for a child, and the single place the fingerprint cache is
 * kept honest — boot resolves credentials through here, so the value it records
 * is by construction the value a later staleness check compares against.
 */
export async function machineProviderEnv(): Promise<Record<string, string>> {
  const env = await computeMachineProviderEnv();
  authFp = { at: Date.now(), value: fingerprintAuthEnv(env) };
  return env;
}

/**
 * Fingerprint of the credentials a child would boot with *right now*.
 *
 * Cached, because the callers are on the message-delivery path and the
 * uncached form shells out to `security` (Keychain) or to `secret`. A Claude
 * Code OAuth token lives ~8h, so a minute of staleness costs nothing and saves
 * a subprocess per message.
 */
export async function currentAuthFingerprint(maxAgeMs = 60_000): Promise<string | null> {
  if (authFp.at > 0 && Date.now() - authFp.at < maxAgeMs) return authFp.value;
  await machineProviderEnv();
  return authFp.value;
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
