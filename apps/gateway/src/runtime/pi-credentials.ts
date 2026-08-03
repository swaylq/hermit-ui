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

const SECRET_BIN = path.join(os.homedir(), '.local', 'bin', 'secret');
const PROVIDER_RE = /^[A-Za-z0-9_-]+$/;

/** `openrouter` -> `OPENROUTER_API_KEY` */
export function envVarForProvider(provider: string): string {
  return `${provider.replace(/-/g, '_').toUpperCase()}_API_KEY`;
}

function readSecret(key: string): Promise<string | null> {
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
