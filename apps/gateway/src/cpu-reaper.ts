// cpu-reaper.ts — kill ORPHANED processes pinned at ~100% CPU on one core for
// hours. The 2026-08-29 incident this answers: 8 `while :; do :; done` loops
// left over from a load-test script (the script's own `kill $(jobs -p)` was
// dead code in a non-interactive shell — job control is off, so `jobs -p` is
// always empty) ran for 12 days as ppid-1 orphans, each pinning a core, load
// 8.4 — and no watchdog of the family touched them: stray-reaper matches only
// chrome-headless-shell, chrome-reaper only chrome.json pidfiles, and the
// launchd watchdog looks at aggregate load, not which process is hot.
//
// A dead loop's fingerprint is not its binary — it can be zsh, node, python —
// it is the CPU: accumulated CPU time rising linearly while nothing else on the
// box does. So the bound is "orphan + accumulated CPU ≥ threshold + pinned at
// ≥ coreFraction of one core for confirmTicks samples in a row". Defaults are
// deliberately loose (2h accumulated, 90% of one core, 3 samples ≈ 15 min): a
// legit one-shot job never accumulates hours of pure CPU, and a live agent's
// turn has the gateway as an ancestor, not pid 1. Loosen further in
// Settings → Watchdogs rather than tightening here.

import { execFileSync } from 'node:child_process';
import { api } from './api';
import { psAll } from './platform';
import { getWatchdogConfig } from './watchdog-config';

export interface CpuProc {
  pid: number;
  ppid: number;
  cpuSec: number; // accumulated CPU seconds, from `ps -o time=`
  command: string;
}

/** ps time: [[dd-]hh:]mm:ss → seconds. Unparseable → 0 (too young to matter). */
export function cpuTimeSeconds(s: string): number {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3]);
  const secs = Number(m[4]);
  return days * 86400 + hours * 3600 + mins * 60 + secs;
}

// System/daemon paths and our own runtime that may legitimately sit at pid 1
// with real CPU. A dead loop is never any of these. Deliberately NOT here:
// /bin/ and /usr/bin/ — a dead loop is exactly /bin/zsh -c 'while :; do :; done'
// (or /usr/bin/node), and the loose CPU threshold is what spares the legitimate
// processes under those paths, not a name filter.
const SKIP_SUBSTRINGS = [
  '/sbin/',
  '/usr/sbin/',
  '/usr/libexec/',
  '/System/Library/',
  'pm2',
  'launchd',
  'hermit-ui', // the gateway and its helpers
  'src/index.ts',
  'claude',
  'tmux',
];

export function isSkip(command: string): boolean {
  return SKIP_SUBSTRINGS.some((s) => command.includes(s));
}

/** Orphaned (ppid 1), non-skip processes with their accumulated CPU time. */
export function listOrphanHot(): CpuProc[] {
  let out: string;
  try {
    out = execFileSync('ps', psAll('pid=,ppid=,time=,command='), { encoding: 'utf8' });
  } catch {
    return [];
  }
  const procs: CpuProc[] = [];
  for (const line of out.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 4) continue;
    const pid = Number(t[0]);
    const ppid = Number(t[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    if (ppid !== 1) continue; // only orphans (reparented to launchd)
    const command = t.slice(3).join(' ');
    if (isSkip(command)) continue;
    procs.push({ pid, ppid, cpuSec: cpuTimeSeconds(t[2] ?? ''), command });
  }
  return procs;
}

// pid → samples oldest→newest, each { cpuSec, at: wall clock ms }. Capped so a
// long-running candidate cannot grow the table unboundedly; dropped when the
// process vanishes. In-memory by design: a gateway restart forgets history and
// simply re-accumulates — the worst case is a few ticks of extra delay.
const history = new Map<number, { cpuSec: number; at: number }[]>();

export function recordSample(pid: number, cpuSec: number, now = Date.now(), keep = 8): void {
  const h = history.get(pid) ?? [];
  h.push({ cpuSec, at: now });
  if (h.length > keep) h.shift();
  history.set(pid, h);
}

export function resetHistory(): void {
  history.clear();
}

/**
 * Pinned at ≥ coreFraction of one core for the last `confirm` consecutive
 * intervals AND old enough (accumulated CPU ≥ minCpuSec)? Pure so it can be
 * tested with synthetic samples.
 */
export function isPinned(
  samples: { cpuSec: number; at: number }[],
  minCpuSec: number,
  coreFraction: number,
  confirm: number,
): boolean {
  if (samples.length < confirm + 1) return false;
  if (samples[samples.length - 1].cpuSec < minCpuSec) return false;
  for (let i = samples.length - confirm; i < samples.length; i++) {
    const dCpu = samples[i].cpuSec - samples[i - 1].cpuSec;
    const dWall = (samples[i].at - samples[i - 1].at) / 1000;
    if (dWall <= 0) return false;
    if (dCpu / dWall < coreFraction) return false;
  }
  return true;
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

export async function cpuReaperTick(): Promise<void> {
  const cfg = (await getWatchdogConfig()).cpuReaper;
  if (!cfg.enabled) return;

  const minCpuSec = cfg.minCpuMinutes * 60;
  const keep = Math.max(cfg.confirmTicks + 3, 8);
  const procs = listOrphanHot();
  const seen = new Set<number>();
  const victims: CpuProc[] = [];

  for (const p of procs) {
    seen.add(p.pid);
    recordSample(p.pid, p.cpuSec, Date.now(), keep);
    const h = history.get(p.pid)!;
    if (isPinned(h, minCpuSec, cfg.minCoreFraction, cfg.confirmTicks)) {
      victims.push(p);
    }
  }

  // Forget pids that vanished, so the table never leaks alongside the CPU.
  for (const pid of [...history.keys()]) {
    if (!seen.has(pid)) history.delete(pid);
  }

  if (victims.length === 0) return;
  for (const v of victims) {
    kill(v.pid);
    history.delete(v.pid);
    console.log(
      `[cpu-reaper] killed pinned orphan pid=${v.pid} cpu=${Math.round(v.cpuSec / 60)}min cmd=${v.command.slice(0, 80)}`,
    );
  }
  try {
    await api.syncMachineAlert({
      kind: 'cpu-leak',
      message: `清掉 ${victims.length} 个占满 CPU 的孤儿进程（每个至少烧了 ${cfg.minCpuMinutes} 分钟）`,
      count: victims.length,
      ttlMinutes: 30,
    });
  } catch {
    /* the kills stand; the dashboard can hear about them next tick */
  }
}
