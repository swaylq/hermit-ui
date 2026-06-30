import 'dotenv/config';
import { spawnSync } from 'node:child_process';

function keychainKey(): string | null {
  const r = spawnSync(
    'security',
    ['find-generic-password', '-a', 'asst', '-s', 'asst-gateway-vps-key', '-w'],
    { encoding: 'utf8', timeout: 1500 },
  );
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

export const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:4101';
export const ASST_KEY: string = process.env.ASST_KEY ?? keychainKey() ?? '';

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

// In hermit-ui dev mode, AGENTS_ROOT points at the monorepo's test workspaces.
// Production override via env when running on a user's machine.
export const AGENTS_ROOT =
  process.env.AGENTS_ROOT ?? '/Users/mac/claudeclaw/asst/hermit-ui/agents';
export const PROJECTS_ROOT =
  process.env.PROJECTS_ROOT ?? '/Users/mac/.claude/projects';
export const LAUNCH_AGENTS_DIR =
  process.env.LAUNCH_AGENTS_DIR ?? '/Users/mac/Library/LaunchAgents';
