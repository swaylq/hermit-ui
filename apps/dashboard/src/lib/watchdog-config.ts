// The fleet's watchdog knobs — one JSON object per machine, edited from
// Settings → Watchdogs and stored on Machine.watchdogConfig.
//
// Six watchdogs, three habitats:
//   dashboard sweeps (stuck, unanswered)   — read this directly, per machine
//   gateway ticks (strayReaper, chromeReaper) and the host red-zone — the
//     gateway polls it (machines.pollWatchdogConfig)
//   the launchd watchdog (gatewayWatch)    — reads a config.env its gateway
//     writes from this same object, so even the fully-outside watcher is set
//     from the same page
//
// Every reader tolerates a null/partial/foreign object and lands on DEFAULTS —
// a hand-edited value must never crash a watcher; the worst it may do is fall
// back. Writers go through machines.setWatchdogConfig (zod, whole-object
// replace).

export interface WatchdogConfig {
  stuck: { enabled: boolean; minutes: number };
  unanswered: { enabled: boolean; minutes: number };
  hostRed: {
    enabled: boolean;
    redFreeMb: number;
    amberFreeMb: number;
    redLoadFactor: number;
    amberLoadFactor: number;
  };
  strayReaper: { enabled: boolean; ageMinutes: number; maxRoots: number };
  chromeReaper: { enabled: boolean; idleMinutes: number };
  gatewayWatch: {
    loadMax: number;
    silentSec: number;
    wedgeFails: number;
    confirmSec: number;
    cooldownSec: number;
  };
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  // Human message undelivered >10min and its session not provably busy
  // (server/machine-alerts.ts). Near-zero false positives at 10.
  stuck: { enabled: true, minutes: 10 },
  // The newest word in a session is the human's, older than this
  // (server/unanswered.ts — 30 from the 61-day distribution in
  // docs/unanswered-alert-design.md).
  unanswered: { enabled: true, minutes: 30 },
  // Host pressure crossing (host-stat sync route). Load factors multiply
  // cpuCount; red RAM 1GB / amber 2.5GB match lib/host-health.ts.
  hostRed: {
    enabled: true,
    redFreeMb: 1024,
    amberFreeMb: 2560,
    redLoadFactor: 2,
    amberLoadFactor: 1,
  },
  // Non-owned chrome-headless-shell: kill roots older than 2h, cap roots at 25
  // (apps/gateway/src/stray-reaper.ts).
  strayReaper: { enabled: true, ageMinutes: 120, maxRoots: 25 },
  // Owned per-agent Chrome, idle without a browser-lock (apps/gateway/src/
  // chrome-reaper.ts).
  chromeReaper: { enabled: true, idleMinutes: 10 },
  // The launchd watchdog (scripts/gateway-watch.sh): starvation probes +
  // wedge-restart confirmations.
  gatewayWatch: { loadMax: 60, silentSec: 600, wedgeFails: 100, confirmSec: 90, cooldownSec: 10800 },
};

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function section(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * Effective config for a machine: DEFAULTS merged under whatever the row holds,
 * per key, with clamps. Unknown keys are dropped, missing keys default — an
 * older dashboard reading a newer gateway's section must not inherit junk.
 */
export function watchdogConfigOf(
  row: { watchdogConfig?: unknown } | null | undefined,
): WatchdogConfig {
  const d = DEFAULT_WATCHDOG_CONFIG;
  const r = section(row?.watchdogConfig);
  const stuck = section(r.stuck);
  const unanswered = section(r.unanswered);
  const hostRed = section(r.hostRed);
  const stray = section(r.strayReaper);
  const chrome = section(r.chromeReaper);
  const gw = section(r.gatewayWatch);
  return {
    stuck: {
      enabled: bool(stuck.enabled, d.stuck.enabled),
      minutes: num(stuck.minutes, d.stuck.minutes, 1, 24 * 60),
    },
    unanswered: {
      enabled: bool(unanswered.enabled, d.unanswered.enabled),
      minutes: num(unanswered.minutes, d.unanswered.minutes, 1, 24 * 60),
    },
    hostRed: {
      enabled: bool(hostRed.enabled, d.hostRed.enabled),
      redFreeMb: num(hostRed.redFreeMb, d.hostRed.redFreeMb, 0, 1_000_000),
      amberFreeMb: num(hostRed.amberFreeMb, d.hostRed.amberFreeMb, 0, 1_000_000),
      redLoadFactor: num(hostRed.redLoadFactor, d.hostRed.redLoadFactor, 0.5, 100),
      amberLoadFactor: num(hostRed.amberLoadFactor, d.hostRed.amberLoadFactor, 0.1, 100),
    },
    strayReaper: {
      enabled: bool(stray.enabled, d.strayReaper.enabled),
      ageMinutes: num(stray.ageMinutes, d.strayReaper.ageMinutes, 5, 7 * 24 * 60),
      maxRoots: num(stray.maxRoots, d.strayReaper.maxRoots, 1, 1000),
    },
    chromeReaper: {
      enabled: bool(chrome.enabled, d.chromeReaper.enabled),
      idleMinutes: num(chrome.idleMinutes, d.chromeReaper.idleMinutes, 1, 24 * 60),
    },
    gatewayWatch: {
      loadMax: num(gw.loadMax, d.gatewayWatch.loadMax, 1, 10000),
      silentSec: num(gw.silentSec, d.gatewayWatch.silentSec, 60, 86400),
      wedgeFails: num(gw.wedgeFails, d.gatewayWatch.wedgeFails, 10, 100000),
      confirmSec: num(gw.confirmSec, d.gatewayWatch.confirmSec, 10, 3600),
      cooldownSec: num(gw.cooldownSec, d.gatewayWatch.cooldownSec, 300, 7 * 86400),
    },
  };
}
