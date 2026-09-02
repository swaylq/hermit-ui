// pm2-config-check.ts — say so, loudly, when pm2 is not running us the way the
// shutdown path assumes.
//
// The trap this exists for: `treekill` and `kill_timeout` live in pm2's stored
// `pm2_env`, and `pm2 restart <name>` does NOT re-read ecosystem.config.cjs —
// it restarts with whatever was saved when the app was first started. So the
// two settings the whole graceful shutdown depends on can sit in the repo,
// committed, reviewed and deployed, while the live process still has
// `treekill: true` and pm2's default 1600ms timeout.
//
// That failure is completely silent. Everything looks right: the file says the
// right thing, the gateway runs the drain, and every restart still guillotines
// every session because the first SIGINT went to the whole subtree before the
// drain had a chance and the SIGKILL arrived 1.6 seconds later. Nobody would
// look here.
//
// One `pm2 jlist` at startup turns that into a line in the log that names the
// command that fixes it.

import { execFile } from 'node:child_process';

/**
 * Fallback only. The real number is computed from the live budgets and passed
 * in: a hardcoded 30s passed this check happily while HERMIT_DRAIN_BUDGET_MS
 * was set to 60s, which is the one configuration where the check most needed to
 * complain.
 */
export const DEFAULT_REQUIRED_KILL_TIMEOUT_MS = 30_000;

export interface Pm2Settings {
  treekill: boolean | null;
  killTimeoutMs: number | null;
}

/** Pull our own app's settings out of `pm2 jlist` output. Exported for the test. */
export function findOwnSettings(jlist: string, appName: string, pmId: number | null): Pm2Settings | null {
  let apps: any[];
  try {
    apps = JSON.parse(jlist);
  } catch {
    return null;
  }
  if (!Array.isArray(apps)) return null;
  // pm_id first: a machine can legitimately run a second gateway entry under
  // another name (a throwaway used to verify a change is the sanctioned way to
  // test one), and matching by name alone would read the wrong row.
  const mine =
    (pmId != null ? apps.find((a) => a?.pm_id === pmId) : undefined) ??
    apps.find((a) => a?.name === appName);
  if (!mine?.pm2_env) return null;
  const env = mine.pm2_env;
  return {
    treekill: typeof env.treekill === 'boolean' ? env.treekill : null,
    killTimeoutMs: typeof env.kill_timeout === 'number' ? env.kill_timeout : null,
  };
}

/**
 * What is wrong, in words, or null when nothing is.
 *
 * Separate from the shelling-out so the wording is assertable — a warning that
 * does not name the fix is a warning people learn to scroll past.
 */
export function complaintsAbout(s: Pm2Settings, requiredMs = DEFAULT_REQUIRED_KILL_TIMEOUT_MS): string[] {
  const out: string[] = [];
  if (s.treekill !== false) {
    out.push(
      'treekill is on, so pm2 sends the first SIGINT to every claude child as well as to us — ' +
      'the drain cannot save a turn that was already interrupted underneath it',
    );
  }
  if (s.killTimeoutMs == null || s.killTimeoutMs < requiredMs) {
    out.push(
      `kill_timeout is ${s.killTimeoutMs == null ? "pm2's 1600ms default" : `${s.killTimeoutMs}ms`}, ` +
      `under the ${requiredMs}ms this gateway's shutdown budget needs — we get SIGKILLed part-way through it`,
    );
  }
  return out;
}

function jlist(): Promise<string | null> {
  return new Promise((resolve) => {
    // 5s: this runs at startup and must never be the reason a gateway is slow
    // to come up. pm2 missing entirely (a dev `tsx src/index.ts`) is not a
    // problem to report — there is no pm2 to misconfigure.
    execFile('pm2', ['jlist'], { timeout: 5_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/**
 * Check once, at startup. Never throws, never blocks anything important.
 */
export async function checkPm2Config(appName = 'hermit-ui-gateway', requiredMs = DEFAULT_REQUIRED_KILL_TIMEOUT_MS): Promise<void> {
  if (!process.env.pm_id) return; // not under pm2; nothing to be wrong
  const out = await jlist();
  if (out == null) return;
  const settings = findOwnSettings(out, appName, Number(process.env.pm_id));
  if (!settings) return;
  const complaints = complaintsAbout(settings, requiredMs);
  if (complaints.length === 0) return;
  console.warn('[pm2-config] this gateway cannot shut down gracefully:');
  for (const c of complaints) console.warn(`[pm2-config]   · ${c}`);
  console.warn(
    '[pm2-config] pm2 keeps these in its own saved copy and `pm2 restart <name>` does not re-read the file. ' +
    'Fix with: pm2 startOrRestart apps/gateway/ecosystem.config.cjs && pm2 save',
  );
}
