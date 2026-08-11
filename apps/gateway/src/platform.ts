// The one place an OS difference is allowed to live.
//
// The gateway was already close to POSIX-clean — every external dependency is
// tmux / ps / tail / zip / node-pty, with no fs.watch, no osascript and no
// launchctl — so making it run on Linux was never a port. It was a handful of
// BSD-only flags and Mac-shaped defaults. See docs/linux-compat-design.md for
// the measured report (Ubuntu 24.04, tmux 3.4, procps-ng 4.0.4).
//
// Three rules this module exists to enforce:
//
//   1. PREFER A COMMAND THAT WORKS ON BOTH over a `if (platform)` branch.
//      `ps -Axo` → `ps -axo` is the pattern: one edit, no branch, and macOS
//      behaviour is byte-identical (measured: 591 lines and the same 30 Chrome
//      rows either way). Branch only where there is genuinely no common form —
//      memory statistics, which is why host-stat still has two functions.
//   2. KEEP THE DIFFERENCES HERE, not spread across fifteen files.
//   3. NEVER DEGRADE SILENTLY. Every Linux bug the audit found was something
//      quietly not working — Chrome census permanently null, a permission hook
//      passing everything, plan-usage burning 30s for nothing. Code either does
//      its job or says loudly what is missing.
//
// Windows is explicitly out of scope: the whole chat model is a long-lived tmux
// pane, which does not exist there. That is a different project, not a flag.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const isDarwin = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/**
 * `ps` selectors for "every process on the box, with this format".
 *
 * `-Axo` is BSD-only. procps rejects it outright — `error: must set personality
 * to get -x option`, exit 1 — which on Linux made the Chrome census return null
 * forever, silently, because the caller catches. Chrome is exactly what OOM'd
 * macmini1 in June, so that monitor going blind is not cosmetic.
 *
 * `-axo` selects the same set on both: identical output on macOS, and on Linux
 * the same rows as `ps -eo` (all users, including pid 1).
 */
export const PS_ALL_ARGS = ['-axo'] as const;

/** `ps` argv for a given output format, portable across BSD and procps. */
export function psAll(format: string): string[] {
  return [...PS_ALL_ARGS, format];
}

/**
 * Directories a login shell would have on PATH but a daemon often does not.
 *
 * pm2 and systemd both hand a child a minimal PATH, and the gateway spawns
 * `claude` (and tmux execs it with the CLIENT's PATH), so a missing entry here
 * shows up as `claude: command not found` in a brand-new pane that then dies —
 * which reads from the dashboard as "the chat never started" (2026-06-10).
 *
 * Non-existent entries on PATH are harmless no-ops, so this returns the union
 * for the platform rather than probing each one. Ordered most-specific first:
 * a user-installed claude in ~/.local/bin should win over a system package.
 */
export function extraBinPaths(): string[] {
  const home = os.homedir();
  const common = [path.join(home, '.local', 'bin'), '/usr/local/bin'];
  if (isDarwin) return [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  // Linux installs claude in more places than macOS does: npm --global with a
  // user prefix, and snap.
  return [...common, path.join(home, '.npm-global', 'bin'), '/snap/bin'];
}

/** `base` with the daemon-missing directories appended. Never returns empty. */
export function pathWith(base = process.env.PATH): string {
  const extras = extraBinPaths();
  if (!base) return [...extras, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const have = new Set(base.split(':'));
  return [base, ...extras.filter((p) => !have.has(p))].join(':');
}

/**
 * Where `claude` is, or null if it cannot be found.
 *
 * Three levels, because the old single hard-coded `~/.local/bin/claude` is
 * right on this fleet's Macs and wrong nearly everywhere else:
 *   1. `HERMIT_CLAUDE_BIN` — the explicit answer, for a machine that installs
 *      it somewhere odd;
 *   2. the PATH (extended with extraBinPaths, since a daemon's PATH is thin);
 *   3. `~/.local/bin/claude`, the native installer's location and the fleet's
 *      historical assumption.
 *
 * Returns null rather than a guessed path so callers can report "claude is not
 * installed" instead of spawning something that does not exist and timing out.
 */
export function findClaudeBin(env = process.env): string | null {
  const explicit = env.HERMIT_CLAUDE_BIN?.trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : null;

  const seen = new Set<string>();
  const dirs = [...(env.PATH?.split(':') ?? []), ...extraBinPaths()];
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, 'claude');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // an unreadable directory on PATH is not this function's problem
    }
  }
  return null;
}
