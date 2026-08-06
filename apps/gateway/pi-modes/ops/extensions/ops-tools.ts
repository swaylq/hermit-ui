// ops mode tools: run a command on a known host, safely.
//
// This exists because the credential rules in SYSTEM.md are the kind a model
// has to remember on every single call — do not put the password in argv, do
// not echo it, feed sudo from stdin, remember the non-standard port. Four rules
// remembered four times an hour is four chances to leak. One tool call is zero.
//
// Loaded with `--extension` by the ops mode (see ../mode.json). pi has no MCP,
// so tools are registered directly, the same way hermit-pi-extension.ts does.
//
// The host list is machine-local data, NOT part of this repo: it lives at
// $AGENTS_ROOT/.hermit/ops-hosts.json so the fleet's two machines can differ and
// so no address or secret name is committed. Missing file = no hosts, and the
// tools say so rather than failing obscurely.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

type Host = {
  /** Hostname or IP. */
  address: string;
  user?: string;
  /** Defaults to 22. Several of ours do not use 22. */
  port?: number;
  /** Secret-store key holding this host's sudo password. Never the value. */
  sudoSecret?: string;
  /** One line for the model: what this box is, and which runbook skill covers it. */
  note?: string;
};

const SECRET_BIN = path.join(os.homedir(), '.local', 'bin', 'secret');
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Per-stream output cap. A journalctl dump will otherwise fill the window. */
const MAX_STREAM_CHARS = 20_000;

function hostsPath(): string {
  const root = process.env.AGENTS_ROOT?.trim();
  if (!root) return '';
  return path.join(root, '.hermit', 'ops-hosts.json');
}

function loadHosts(): Record<string, Host> {
  const p = hostsPath();
  if (!p || !fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { hosts?: Record<string, Host> };
    return parsed.hosts ?? {};
  } catch (e) {
    console.warn(`[ops-tools] ${p} is not valid JSON:`, (e as Error).message);
    return {};
  }
}

/** Read a secret by name. Resolves null on any failure — callers report, never retry blind. */
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

/** Single-quote for a POSIX shell. The only escape needed inside '' is '' itself. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function clip(s: string): string {
  if (s.length <= MAX_STREAM_CHARS) return s;
  const half = Math.floor(MAX_STREAM_CHARS / 2);
  return `${s.slice(0, half)}\n\n…[${s.length - MAX_STREAM_CHARS} chars elided]…\n\n${s.slice(-half)}`;
}

type RunResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

function runSsh(args: string[], stdin: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(
      'ssh',
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        if (e && (e as { signal?: string }).signal === 'SIGTERM') timedOut = true;
        resolve({
          exitCode: typeof e?.code === 'number' ? e.code : e ? null : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut,
        });
      },
    );
    // The ONLY thing that ever goes down stdin is the sudo password. It is
    // written and the stream closed immediately; it is never logged, never
    // returned, and never placed in argv where the remote `ps` would show it.
    if (stdin) child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} required`);
  return v;
};

export default function opsTools(pi: any): void {
  pi.registerTool({
    name: 'ssh_hosts',
    description:
      'List the machines this agent can reach with ssh_run: alias, what the box is, and whether a sudo credential is registered for it. Call this first when you do not know the alias.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const hosts = loadHosts();
      const names = Object.keys(hosts).sort();
      if (names.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No hosts registered. Expected ${hostsPath() || '$AGENTS_ROOT/.hermit/ops-hosts.json'} `
              + `with {"hosts": {"<alias>": {"address": "...", "user": "...", "port": 22, "sudoSecret": "KEY_NAME", "note": "..."}}}.`,
          }],
        };
      }
      const lines = names.map((n) => {
        const h = hosts[n];
        const target = `${h.user ? `${h.user}@` : ''}${h.address}${h.port && h.port !== 22 ? `:${h.port}` : ''}`;
        return `- ${n} → ${target}${h.sudoSecret ? ' [sudo available]' : ' [no sudo credential]'}`
          + `${h.note ? `\n    ${h.note}` : ''}`;
      });
      return { content: [{ type: 'text', text: `Reachable hosts:\n${lines.join('\n')}` }] };
    },
  });

  pi.registerTool({
    name: 'ssh_run',
    description:
      'Run a shell command on a registered remote host over SSH. Resolves the alias (including non-standard ports) and, with sudo=true, supplies that host\'s sudo password from the encrypted store via stdin — the value never appears in a command line, a log, or this conversation. Returns exit code, stdout and stderr separately. Use ssh_hosts to see aliases. For commands on THIS machine, use bash instead.',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Alias from ssh_hosts.' },
        command: { type: 'string', description: 'Shell command to run on that host.' },
        sudo: {
          type: 'boolean',
          description: 'Run via sudo, supplying the password from the store. Only when the command genuinely needs root — most status checks do not.',
        },
        timeoutSeconds: { type: 'number', description: 'Default 120, max 600.' },
      },
      required: ['host', 'command'],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const alias = str(params.host, 'host');
      const command = str(params.command, 'command');
      const wantSudo = params.sudo === true;

      const hosts = loadHosts();
      const h = hosts[alias];
      if (!h) {
        const known = Object.keys(hosts).sort();
        throw new Error(
          `unknown host "${alias}". ${known.length ? `Registered: ${known.join(', ')}` : 'No hosts registered — see ssh_hosts.'}`,
        );
      }

      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(1_000, Number(params.timeoutSeconds ?? 0) * 1000 || DEFAULT_TIMEOUT_MS),
      );

      let stdin = '';
      let remote = `bash -c ${shQuote(command)}`;
      if (wantSudo) {
        if (!h.sudoSecret) {
          throw new Error(
            `host "${alias}" has no sudoSecret registered, so sudo cannot be supplied. `
              + `Either run the command without sudo, or add the secret's key name to ops-hosts.json.`,
          );
        }
        const pw = await readSecret(h.sudoSecret);
        if (!pw) {
          throw new Error(
            `secret "${h.sudoSecret}" is not readable from this machine's store, so sudo on "${alias}" is unavailable.`,
          );
        }
        // -S reads the password from stdin, -p '' suppresses the prompt so it
        // does not end up interleaved in stderr.
        remote = `sudo -S -p '' bash -c ${shQuote(command)}`;
        stdin = `${pw}\n`;
      }

      const args = [
        '-o', 'BatchMode=yes', // never sit at an interactive auth prompt
        '-o', 'ConnectTimeout=10',
        ...(h.port && h.port !== 22 ? ['-p', String(h.port)] : []),
        `${h.user ? `${h.user}@` : ''}${h.address}`,
        remote,
      ];

      const r = await runSsh(args, stdin, timeoutMs);

      const parts = [`host: ${alias}  exit: ${r.timedOut ? 'TIMED OUT' : r.exitCode ?? 'unknown'}`];
      if (r.stdout.trim()) parts.push(`--- stdout ---\n${clip(r.stdout.trimEnd())}`);
      if (r.stderr.trim()) parts.push(`--- stderr ---\n${clip(r.stderr.trimEnd())}`);
      if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(no output)');
      if (r.timedOut) parts.push(`(killed after ${Math.round(timeoutMs / 1000)}s)`);

      return { content: [{ type: 'text', text: parts.join('\n') }] };
    },
  });
}
