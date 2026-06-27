// collect/host-stat.ts — host-level resource snapshot (RAM / swap / load / cpu).
//
// Pushed every ~30s to /api/sync/host-stat → upserts HostStat. Drives the Host-
// health panel + the red-pressure notification. Health colour keys on free-RAM +
// load, NOT swap-used (macOS lazily reclaims swapfiles → swap-used stays stale;
// macmini1 incident §3). Cross-platform: macOS via vm_stat/sysctl, Linux via
// /proc, with node:os as the portable fallback.

import os from 'node:os';
import { execFile } from 'node:child_process';

export interface HostStatSample {
  ramTotalMb: number | null;
  ramFreeMb: number | null;
  swapUsedMb: number | null;
  swapTotalMb: number | null;
  loadAvg1: number | null;
  cpuCount: number | null;
}

const MB = 1024 * 1024;

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout ?? ''));
    } catch {
      resolve(null);
    }
  });
}

// macOS: vm_stat for free pages (os.freemem() counts ONLY truly-free pages, which
// is always tiny on macOS — the meaningful headroom is free+inactive+speculative),
// sysctl vm.swapusage for swap.
async function macStat(): Promise<Partial<HostStatSample>> {
  const out: Partial<HostStatSample> = {};
  const sw = await run('sysctl', ['-n', 'vm.swapusage']); // "total = 2048.00M  used = 12.34M  free = ..."
  if (sw) {
    const total = sw.match(/total = ([\d.]+)M/);
    const used = sw.match(/used = ([\d.]+)M/);
    if (total) out.swapTotalMb = Math.round(Number(total[1]));
    if (used) out.swapUsedMb = Math.round(Number(used[1]));
  }
  const vm = await run('vm_stat', []);
  if (vm) {
    const pageSize = Number(vm.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
    const pages = (re: RegExp) => Number(vm.match(re)?.[1] ?? 0);
    const free = pages(/Pages free:\s+(\d+)/);
    const inactive = pages(/Pages inactive:\s+(\d+)/);
    const spec = pages(/Pages speculative:\s+(\d+)/);
    out.ramFreeMb = Math.round(((free + inactive + spec) * pageSize) / MB);
  }
  return out;
}

// Linux: MemAvailable is the kernel's own "headroom" estimate; swap from meminfo.
async function linuxStat(): Promise<Partial<HostStatSample>> {
  const out: Partial<HostStatSample> = {};
  const mi = await run('cat', ['/proc/meminfo']);
  if (mi) {
    const kb = (k: string) => Number(mi.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'))?.[1] ?? NaN);
    const avail = kb('MemAvailable');
    const swTotal = kb('SwapTotal');
    const swFree = kb('SwapFree');
    if (Number.isFinite(avail)) out.ramFreeMb = Math.round(avail / 1024);
    if (Number.isFinite(swTotal)) out.swapTotalMb = Math.round(swTotal / 1024);
    if (Number.isFinite(swTotal) && Number.isFinite(swFree)) out.swapUsedMb = Math.round((swTotal - swFree) / 1024);
  }
  return out;
}

export async function collectHostStat(): Promise<HostStatSample> {
  // Portable baseline from node:os; the platform probes refine ramFree + swap.
  const base: HostStatSample = {
    ramTotalMb: Math.round(os.totalmem() / MB),
    ramFreeMb: Math.round(os.freemem() / MB),
    swapUsedMb: null,
    swapTotalMb: null,
    loadAvg1: os.loadavg()[0] ?? null,
    cpuCount: os.cpus().length || null,
  };
  try {
    const extra =
      process.platform === 'darwin' ? await macStat() :
      process.platform === 'linux' ? await linuxStat() : {};
    // The probes only set a key when they parsed a real number (never null), so
    // assigning over the baseline can't clobber a good value with null.
    Object.assign(base, extra);
  } catch {
    /* keep the portable baseline */
  }
  return base;
}
