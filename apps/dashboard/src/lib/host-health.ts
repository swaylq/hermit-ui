// Shared host-health classification — used by the sidebar health chip/panel AND
// the host-stat sync route's red-crossing alert, so "what counts as red" lives in
// exactly one place.
//
// Health keys on free-RAM + load ONLY — never swap-used. macOS lazily reclaims
// swapfiles, so swap-used stays high long after pressure clears (the macmini1
// incident report §3): a swap-based health signal would cry wolf for hours.

export type HostHealth = 'green' | 'amber' | 'red';

export interface HostHealthInput {
  ramFreeMb?: number | null;
  loadAvg1?: number | null;
  cpuCount?: number | null;
}

const RED_FREE_MB = 1024; // < 1 GB headroom
const AMBER_FREE_MB = 2560; // < 2.5 GB headroom

// Settings → Watchdogs can move these per machine; the sync route and the
// hosts router both pass the machine's stored values in. Defaults here match
// DEFAULT_WATCHDOG_CONFIG.hostRed — the two must not drift.
export interface HostHealthThresholds {
  redFreeMb: number;
  amberFreeMb: number;
  redLoadFactor: number;
  amberLoadFactor: number;
}

export function hostHealth(s: HostHealthInput, t?: HostHealthThresholds): HostHealth {
  const redFree = t?.redFreeMb ?? RED_FREE_MB;
  const amberFree = t?.amberFreeMb ?? AMBER_FREE_MB;
  const redLoadF = t?.redLoadFactor ?? 2;
  const amberLoadF = t?.amberLoadFactor ?? 1;
  const free = s.ramFreeMb ?? null;
  const load = s.loadAvg1 ?? null;
  const cpu = s.cpuCount ?? null;
  const redRam = free != null && free < redFree;
  const redLoad = load != null && cpu != null && load > redLoadF * cpu;
  if (redRam || redLoad) return 'red';
  const amberRam = free != null && free < amberFree;
  const amberLoad = load != null && cpu != null && load > amberLoadF * cpu;
  if (amberRam || amberLoad) return 'amber';
  return 'green';
}

// A sample older than this is treated as stale (gateway down / not pushing) — the
// UI greys the chip; do not raise a fresh alert off stale numbers.
const STALE_MS = 120_000;

export function isStale(sampledAt?: Date | string | null): boolean {
  if (!sampledAt) return true;
  const t = typeof sampledAt === 'string' ? Date.parse(sampledAt) : sampledAt.getTime();
  return Number.isFinite(t) ? Date.now() - t > STALE_MS : true;
}

export function fmtGB(mb?: number | null): string {
  return mb == null ? '—' : (mb / 1024).toFixed(1);
}
