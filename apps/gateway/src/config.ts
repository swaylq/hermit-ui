import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isDarwin } from './platform';

function keychainKey(): string | null {
  // Keychain is macOS-only. Elsewhere `security` does not exist and spawnSync
  // returns an error object rather than throwing, so this used to "work" by
  // failing — one pointless spawn on every Linux boot, and a misleading line in
  // any strace of the startup path. Ask the question only where it has an answer.
  if (!isDarwin) return null;
  const r = spawnSync(
    'security',
    ['find-generic-password', '-a', 'asst', '-s', 'asst-gateway-vps-key', '-w'],
    { encoding: 'utf8', timeout: 1500 },
  );
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

export const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:4101';
export const ASST_KEY: string = process.env.ASST_KEY ?? keychainKey() ?? '';

// Where the agent workspaces are. REQUIRED — no default.
//
// It used to fall back to one developer's absolute path. On any other machine
// that is a directory which does not exist, and the failure mode is the worst
// kind: nothing crashes, every collector just finds no agents and the dashboard
// shows an empty, healthy-looking fleet. Refusing to start is louder and takes
// a minute to fix; a silently empty fleet has taken hours to notice.
export const AGENTS_ROOT: string = process.env.AGENTS_ROOT ?? '';

/**
 * Refuse to run without the settings that have no safe default.
 *
 * Called from index.ts — the gateway's entry point — rather than at import
 * time, which is where the ASST_KEY check used to live. Importing a module
 * must not be able to kill the process: half the test suite imports something
 * that transitively imports this file, so an import-time `process.exit(1)`
 * takes down every one of those tests on any machine without a populated .env.
 * (It went unnoticed on this fleet's Macs because the keychain fallback
 * happened to satisfy ASST_KEY there and nothing else was required.)
 *
 * Production behaviour is unchanged: same messages, same exit code, still
 * before any work starts, so pm2's exponential backoff throttles the retries
 * exactly as before.
 */
export function assertRequiredConfig(): void {
  if (!ASST_KEY) {
    // .env is the reliable source: the keychain fallback (asst-gateway-vps-key) is
    // UNREADABLE from a non-GUI/SSH session, so a box recovered over SSH after an
    // OOM crash-loops here forever (2026-06-30 macmini1 incident). Make the fix
    // obvious and let pm2's exponential backoff (ecosystem) throttle the retries.
    console.error(
      '[gateway] missing ASST_KEY — set it in apps/gateway/.env (ASST_KEY=…). ' +
        'Keychain item asst-gateway-vps-key is only an optional fallback and cannot ' +
        'be read from an SSH/headless session. Refusing to start.',
    );
    process.exit(1);
  }

  if (!AGENTS_ROOT) {
    console.error(
      '[gateway] missing AGENTS_ROOT — set it in apps/gateway/.env ' +
        '(AGENTS_ROOT=/absolute/path/to/agents). It is the directory holding the ' +
        'agent workspaces; there is no sensible default. Refusing to start.',
    );
    process.exit(1);
  }
}

// Claude Code's own project directory. `.env.example` has always documented
// this as "defaults to a path under $HOME" — the code disagreed and hard-coded
// /Users/mac. The docs were right.
export const PROJECTS_ROOT =
  process.env.PROJECTS_ROOT ?? path.join(os.homedir(), '.claude', 'projects');

// ── Live preview (src/preview/) ──────────────────────────────────────────────
// Public base the dashboard iframes; the serve port below is what the rathole
// `preview` service tunnels to it. Admin is the loopback-only registration API
// for the hermit-preview CLI and must NEVER appear in a tunnel config.
export const PREVIEW_PUBLIC_BASE = process.env.PREVIEW_PUBLIC_BASE ?? 'https://preview.swaylab.ai';
export const PREVIEW_SERVE_PORT = Number(process.env.PREVIEW_SERVE_PORT ?? 4180);
export const PREVIEW_ADMIN_PORT = Number(process.env.PREVIEW_ADMIN_PORT ?? 4181);
// Extra allowed static roots beyond AGENTS_ROOT + ~/.hermit/worktrees, colon-separated.
export const PREVIEW_ALLOW_ROOTS = (process.env.PREVIEW_ALLOW_ROOTS ?? '').split(':').filter(Boolean);
