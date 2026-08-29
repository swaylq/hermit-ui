// watchdog-config.ts — the gateway's read of Settings → Watchdogs.
//
// Polled off the dashboard (machines.pollWatchdogConfig) with a 30s TTL cache,
// the pi-config.ts pattern: a poll failure keeps the last good value and a
// first-boot failure lands on DEFAULTS — a watcher must never go down because
// its settings did.
//
// Two consumers: the reaper ticks read their knobs from here per tick, and the
// gatewayWatch section is mirrored to ~/.hermit/gateway-watch/config.env — the
// file the launchd watchdog (scripts/gateway-watch.sh) sources, so even the
// watcher that lives fully outside pm2 is set from the same Settings page.
//
// DEFAULTS are kept in step with apps/dashboard/src/lib/watchdog-config.ts BY
// HAND — the dashboard is the writer, this is a reader, and a reader whose
// defaults drifted would silently fight the page's "Defaults" button.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { api } from './api';

export interface GatewayWatchdogConfig {
  strayReaper: { enabled: boolean; ageMinutes: number; maxRoots: number };
  chromeReaper: { enabled: boolean; idleMinutes: number };
  cpuReaper: {
    enabled: boolean;
    minCpuMinutes: number;
    minCoreFraction: number;
    confirmTicks: number;
  };
  gatewayWatch: {
    loadMax: number;
    silentSec: number;
    wedgeFails: number;
    confirmSec: number;
    cooldownSec: number;
  };
}

const DEFAULTS: GatewayWatchdogConfig = {
  strayReaper: { enabled: true, ageMinutes: 120, maxRoots: 25 },
  chromeReaper: { enabled: true, idleMinutes: 10 },
  cpuReaper: { enabled: true, minCpuMinutes: 120, minCoreFraction: 0.9, confirmTicks: 3 },
  gatewayWatch: { loadMax: 60, silentSec: 600, wedgeFails: 100, confirmSec: 90, cooldownSec: 10800 },
};

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function parse(raw: unknown): GatewayWatchdogConfig {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const sec = (k: string) => {
    const s = r[k];
    return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
  };
  const stray = sec('strayReaper');
  const chrome = sec('chromeReaper');
  const cpu = sec('cpuReaper');
  const gw = sec('gatewayWatch');
  const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb);
  return {
    strayReaper: {
      enabled: bool(stray.enabled, DEFAULTS.strayReaper.enabled),
      ageMinutes: num(stray.ageMinutes, DEFAULTS.strayReaper.ageMinutes, 5, 7 * 24 * 60),
      maxRoots: num(stray.maxRoots, DEFAULTS.strayReaper.maxRoots, 1, 1000),
    },
    chromeReaper: {
      enabled: bool(chrome.enabled, DEFAULTS.chromeReaper.enabled),
      idleMinutes: num(chrome.idleMinutes, DEFAULTS.chromeReaper.idleMinutes, 1, 24 * 60),
    },
    cpuReaper: {
      enabled: bool(cpu.enabled, DEFAULTS.cpuReaper.enabled),
      minCpuMinutes: num(cpu.minCpuMinutes, DEFAULTS.cpuReaper.minCpuMinutes, 10, 7 * 24 * 60),
      minCoreFraction: num(cpu.minCoreFraction, DEFAULTS.cpuReaper.minCoreFraction, 0.5, 1),
      confirmTicks: num(cpu.confirmTicks, DEFAULTS.cpuReaper.confirmTicks, 1, 20),
    },
    gatewayWatch: {
      loadMax: num(gw.loadMax, DEFAULTS.gatewayWatch.loadMax, 1, 10000),
      silentSec: num(gw.silentSec, DEFAULTS.gatewayWatch.silentSec, 60, 86400),
      wedgeFails: num(gw.wedgeFails, DEFAULTS.gatewayWatch.wedgeFails, 10, 100000),
      confirmSec: num(gw.confirmSec, DEFAULTS.gatewayWatch.confirmSec, 10, 3600),
      cooldownSec: num(gw.cooldownSec, DEFAULTS.gatewayWatch.cooldownSec, 300, 7 * 86400),
    },
  };
}

let cache: GatewayWatchdogConfig | null = null;
let lastFetched = 0;
const TTL_MS = 30_000;

// ── config.env for the launchd watchdog ─────────────────────────────────────
//
// Written only when the gatewayWatch section actually changed: the launchd
// script sources this file at every (hourly) run, and a file that never moves
// keeps mtimes honest for anyone debugging "is the new value live yet".
function configEnvPath(): string {
  return path.join(os.homedir(), '.hermit', 'gateway-watch', 'config.env');
}

function syncLaunchdConfig(gw: GatewayWatchdogConfig['gatewayWatch']): void {
  const body =
    `# Written by the hermit gateway from Settings → Watchdogs — do not edit by hand,\n` +
    `# the next config poll overwrites it. Sourced by scripts/gateway-watch.sh.\n` +
    `GW_LOAD_MAX=${gw.loadMax}\n` +
    `GW_SILENT_SEC=${gw.silentSec}\n` +
    `GW_WEDGE_FAILS=${gw.wedgeFails}\n` +
    `GW_CONFIRM_SEC=${gw.confirmSec}\n` +
    `GW_COOLDOWN_SEC=${gw.cooldownSec}\n`;
  const p = configEnvPath();
  try {
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === body) return; // no change
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, p);
    console.log('[watchdog-config] launchd config.env updated from Settings → Watchdogs');
  } catch (e) {
    // A failed write leaves the launchd script on its built-in defaults — log
    // and carry on, the gateway's own ticks are unaffected.
    console.log(`[watchdog-config] could not write ${p}: ${e instanceof Error ? e.message : e}`);
  }
}

export async function getWatchdogConfig(force = false): Promise<GatewayWatchdogConfig> {
  if (cache && !force && Date.now() - lastFetched < TTL_MS) return cache;
  try {
    const raw = await api.pollWatchdogConfig();
    const parsed = parse(raw);
    cache = parsed;
    lastFetched = Date.now();
    syncLaunchdConfig(parsed.gatewayWatch);
  } catch {
    // Dashboard blip — keep the last good config, or the defaults on first boot.
  }
  return cache ?? DEFAULTS;
}

/** Tests. */
export function resetWatchdogConfigCache(): void {
  cache = null;
  lastFetched = 0;
}
