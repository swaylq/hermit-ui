// Secrets — serves the dashboard's encrypted-secrets view over the control-channel
// (secrets.req → secrets.res). The encrypted store (~/.claude/global-memory/
// secrets.age) is decrypted HERE, where the age master key lives in this host's
// Keychain — the dashboard (on the VPS) can't decrypt it. We shell out to the
// `secret` CLI (~/.local/bin/secret) via execFile (NO shell → no injection), and
// for `set` the value is fed on the child's STDIN, never on argv (keeps it out of
// `ps` and any log). Values only ever flow back to the browser on an explicit
// reveal; nothing here is logged.

import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

export type SecretsResult = { ok: true; data: unknown } | { ok: false; error: string };

const SECRET_BIN = path.join(os.homedir(), '.local', 'bin', 'secret');
const KEY_RE = /^[A-Za-z0-9_]+$/;

// Run the secret CLI without a shell. stdin (for `set`) is written then closed;
// for ops that don't read stdin we still close it so the pipe never dangles.
function run(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      SECRET_BIN,
      args,
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim() || 'secret CLI failed'));
        resolve(stdout);
      },
    );
    if (stdin !== undefined) child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

export async function handleSecretsReq(
  op: string,
  params: { key?: string; value?: string },
): Promise<SecretsResult> {
  try {
    switch (op) {
      case 'list': {
        const out = await run(['list']);
        return { ok: true, data: { keys: out.trim().split('\n').filter(Boolean) } };
      }
      case 'reveal': {
        const key = params.key ?? '';
        if (!KEY_RE.test(key)) return { ok: false, error: 'bad key name' };
        const out = await run(['get', key]);
        return { ok: true, data: { value: out.replace(/\n$/, '') } };
      }
      case 'set': {
        const key = params.key ?? '';
        if (!KEY_RE.test(key)) return { ok: false, error: 'bad key name' };
        if (typeof params.value !== 'string' || params.value.length === 0) {
          return { ok: false, error: 'empty value' };
        }
        await run(['set', key], params.value); // value via stdin, never argv
        return { ok: true, data: { ok: true } };
      }
      case 'rm': {
        const key = params.key ?? '';
        if (!KEY_RE.test(key)) return { ok: false, error: 'bad key name' };
        await run(['rm', key]);
        return { ok: true, data: { ok: true } };
      }
      default:
        return { ok: false, error: `unknown op: ${op}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
