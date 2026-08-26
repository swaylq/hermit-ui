// stray-reaper.ts — kill headless browsers the gateway does NOT own, before they
// pile up and strangle the host.
//
// Why this exists (2026-08-26, sway003-macmini): an agent-written batch script
// (batch-extract.mjs) leaked Playwright chrome-headless-shell instances — its own
// leak watchdog was dead code (Linux-only `ps etimes` on macOS, exception swallowed
// by a catch{}), so 88 root browsers / 391 processes accumulated over 8 hours,
// driving the box to load 237 with swap full. Every gateway tick slowed to
// 130–220s and chat stopped delivering fleet-wide. The chrome-reaper beside this
// file watched it happen: it only ever touches gateway-OWNED Chrome (the per-agent
// chrome.json pidfiles), and these were nobody's.
//
// The lesson that shapes this file: a leak watchdog inside the leaking script
// cannot be trusted (it is one silent bug away from never running — exactly what
// happened). The bound has to live OUTSIDE, on the fleet, matching the BINARY
// PATH (unambiguous) rather than launch flags a launcher may or may not pass.
//
// Two caps, both on root browsers only (a root = its parent is not itself a
// headless shell; children die with their root):
//   - AGE:  any non-owned root older than HERMIT_STRAY_AGE_MS (default 2h) is a
//     leak. Legit automation is driven by turns and recycles browsers far sooner;
//     a 2-hour-old unowned headless shell is a zombie.
//   - COUNT: more than HERMIT_STRAY_MAX_ROOTS (default 25) non-owned roots at
//     once is a runaway, regardless of age — kill oldest first until under cap.
//
// Kills are reported (kind 'chrome-leak') via /api/sync/machine-alert: one banner
// + one push, re-pushing at most every 30 min while a leak keeps producing work.

import { execFileSync } from 'node:child_process';
import { api } from './api';
import { psAll } from './platform';
import { getWatchdogConfig } from './watchdog-config';

export interface StrayProc {
  pid: number;
  ppid: number;
  ageSec: number;
  command: string;
}

/** macOS ps etime: [[dd-]hh:]mm:ss → seconds. Unparseable → 0 (too young to kill). */
export function etimeSeconds(s: string): number {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3]);
  const secs = Number(m[4]);
  return days * 86400 + hours * 3600 + mins * 60 + secs;
}

/**
 * Every chrome-headless-shell process on the box. Matches the binary PATH, not
 * launch flags: Playwright's headless shell does not carry `--headless` on its
 * command line (verified 2026-08-26 — the incident script's own reaper matched
 * on that flag and so never matched anything).
 */
export function listStrays(): StrayProc[] {
  let out: string;
  try {
    out = execFileSync('ps', psAll('pid=,ppid=,etime=,command='), { encoding: 'utf8' });
  } catch {
    return [];
  }
  const procs: StrayProc[] = [];
  for (const line of out.split('\n')) {
    if (!line.includes('/ms-playwright/') || !line.includes('chrome-headless-shell')) continue;
    const t = line.trim().split(/\s+/);
    const pid = Number(t[0]);
    const ppid = Number(t[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    procs.push({ pid, ppid, ageSec: etimeSeconds(t[2] ?? ''), command: t.slice(3).join(' ') });
  }
  return procs;
}

/** Roots = shells whose parent is not itself a shell (each root owns a process tree). */
export function rootsOf(procs: StrayProc[]): StrayProc[] {
  const pids = new Set(procs.map((p) => p.pid));
  return procs.filter((p) => !pids.has(p.ppid));
}

/**
 * Which roots die this tick, pure so the decision can be tested directly:
 * everything older than ageMs, then — if the survivors still exceed maxRoots —
 * the oldest survivors until under cap.
 */
export function selectVictims(roots: StrayProc[], ageMs: number, maxRoots: number): StrayProc[] {
  const killed = roots.filter((r) => r.ageSec * 1000 >= ageMs);
  const survivors = roots.filter((r) => !killed.includes(r)).sort((a, b) => b.ageSec - a.ageSec);
  while (survivors.length > maxRoots) killed.push(survivors.shift()!);
  return killed;
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

export async function strayReaperTick(): Promise<void> {
  const cfg = (await getWatchdogConfig()).strayReaper;
  if (!cfg.enabled) return;
  const ageMs = Number(process.env.HERMIT_STRAY_AGE_MS ?? cfg.ageMinutes * 60_000);
  const maxRoots = Number(process.env.HERMIT_STRAY_MAX_ROOTS ?? cfg.maxRoots);

  const procs = listStrays();
  if (procs.length === 0) return;

  // Owned browsers stay untouched. Gateway-owned Chrome is full Chrome via
  // chrome-launcher.sh (not headless shell), so the path filter already excludes
  // it — this pidfile sweep is belt-and-braces for any future headless owned
  // browser: anything a chrome.json still claims is not ours to kill.
  const owned = new Set<number>();
  try {
    const entries = await api.listAgentDirectories();
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const e of entries) {
      if (!e.directory) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(e.directory, 'browser', 'chrome.json'), 'utf8'));
        const pid = Number(j?.pid);
        if (Number.isFinite(pid) && pid > 0) owned.add(pid);
      } catch {
        /* no chrome.json for this agent */
      }
    }
  } catch {
    // Dashboard blip: with no ownership info the safe move is to do nothing
    // this tick — killing blind is the one failure mode worse than a leak.
    return;
  }

  const roots = rootsOf(procs).filter((r) => !owned.has(r.pid));
  if (roots.length === 0) return;

  const killed = selectVictims(roots, ageMs, maxRoots);
  if (killed.length === 0) return;
  for (const r of killed) {
    kill(r.pid);
    console.log(`[stray-reaper] killed stray headless browser pid=${r.pid} age=${Math.round(r.ageSec / 60)}min`);
  }
  const oldestMin = Math.round(Math.max(...killed.map((r) => r.ageSec)) / 60);
  try {
    await api.syncMachineAlert({
      kind: 'chrome-leak',
      message: `清掉 ${killed.length} 个泄漏的无头浏览器（最老 ${oldestMin} 分钟，全机共 ${procs.length} 个相关进程）`,
      count: killed.length,
      ttlMinutes: 30,
    });
  } catch {
    /* the kills still stand; the dashboard can hear about them next time */
  }
}
