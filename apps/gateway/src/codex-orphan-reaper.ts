// codex-orphan-reaper.ts — kill `codex exec` processes a DEAD gateway left
// behind, before they wedge their threads.
//
// Why this exists (2026-08-29, mac-local): a gateway restart orphaned the
// in-flight turn's codex exec (it is a grandchild of pm2, not killed with the
// gateway). Codex's thread store keeps an "active writer" lock per thread, so
// the new gateway's resume of that thread died with
// `thread-store conflict: thread … already has an active writer` and the user's
// message produced nothing but `[codex could not run this turn]`. The orphan
// also kept burning the plan for nearly three hours — nobody was watching it.
//
// The signature is two conditions, both required:
//   - ppid 1: the spawning gateway is gone (orphans reparent to launchd, and to
//     pid 1 under pm2 on Linux too — pm2 never sets CHILD_SUBREAPER, measured
//     on dgx-spark). A live gateway's in-flight turn has the gateway as an
//     ancestor, so a restart-in-progress never kills the new incarnation's
//     children.
//   - argv carries `mcp_servers.hermit` AND the binary runs as
//     `<…>/bin/codex exec`: only a hermit gateway passes that config, so a
//     human's terminal codex never matches, and neither do helper processes
//     (codex-code-mode-host) or other subcommands (app-server). KNOWN GAP:
//     HERMIT_CODEX_BIN pointed at a path without `/bin/codex` in it escapes
//     this filter — its orphans are never reaped.
//
// Same family as stray-reaper.ts / orphan-pane-reaper.ts: the bound lives on
// the fleet side, not inside the thing that leaks.

import { execFileSync } from 'node:child_process';
import { psAll } from './platform';

// Per-tick blast-radius cap. More orphans than this means something structural
// is wrong and mass-killing is the worst response to a diagnosis we don't have.
const MAX_KILLS_PER_TICK = 10;

export interface PsRow {
  pid: number;
  ppid: number;
  command: string;
}

/** Parse `ps -axo pid=,ppid=,command=` output. Unparseable lines are skipped. */
export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

/** The orphan signature, on one parsed ps row. */
export function isCodexOrphan(r: PsRow): boolean {
  return (
    r.ppid === 1 &&
    // The vendored binary's argv is `<…>/bin/codex exec …`; matching the two
    // together excludes `codex-code-mode-host` helpers and other subcommands.
    /\/bin\/codex exec /.test(r.command) &&
    r.command.includes('mcp_servers.hermit')
  );
}

export interface KillPlan {
  pid: number;
  signal: 'SIGTERM' | 'SIGKILL';
}

/**
 * Which processes to kill, and how. Pure and separate on purpose: the function
 * that ends processes should be assertable without a machine full of real
 * orphans.
 *
 * A pid already SIGTERM'd by an earlier tick and STILL in the ps table gets
 * SIGKILL — a codex exec that defers or ignores TERM would otherwise be
 * re-TERMed forever, the thread lock held the whole time.
 */
export function planKills(
  rows: PsRow[],
  termSent: ReadonlySet<number>,
  cap = MAX_KILLS_PER_TICK,
): { kills: KillPlan[]; overflow: number } {
  const orphans = rows.filter(isCodexOrphan);
  const kills = orphans.slice(0, cap).map((r) => ({
    pid: r.pid,
    signal: (termSent.has(r.pid) ? 'SIGKILL' : 'SIGTERM') as 'SIGTERM' | 'SIGKILL',
  }));
  return { kills, overflow: Math.max(0, orphans.length - kills.length) };
}

/**
 * One sweep: find gateway-spawned codex execs whose gateway is dead and kill
 * them. Runs at startup (a restart's orphans exist from the first second —
 * pass awaitExitMs there so no resume can hit a still-held lock) and then
 * periodically, in case a child outlives its turn some other way.
 */
export async function codexOrphanReaperTick(awaitExitMs = 0): Promise<void> {
  let out: string;
  try {
    out = execFileSync('ps', psAll('pid=,ppid=,command='), { encoding: 'utf8' });
  } catch {
    return; // ps failing is a host problem; never let the reaper crash the loop
  }
  const rows = parsePs(out);
  const { kills, overflow } = planKills(rows, termSent);
  if (overflow > 0) {
    console.warn(`[codex-orphan] ${overflow} more orphan(s) beyond the per-tick cap, next tick gets them`);
  }
  const sent: number[] = [];
  for (const kill of kills) {
    try {
      process.kill(kill.pid, kill.signal);
      sent.push(kill.pid);
      if (kill.signal === 'SIGKILL') {
        console.warn(`[codex-orphan] pid ${kill.pid} ignored SIGTERM last tick, sent SIGKILL`);
      } else {
        termSent.add(kill.pid);
        console.warn(`[codex-orphan] SIGTERM pid ${kill.pid} (dead gateway's turn, holding its thread lock)`);
      }
    } catch (e) {
      // ESRCH: already gone between ps and kill — the desired end state.
      // Anything else (EPERM on a multi-user box, say) must be LOUD: a silent
      // failure here is exactly the wedge this file exists to prevent.
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.warn(`[codex-orphan] kill pid ${kill.pid} failed:`, e);
      }
    }
  }
  // Forget pids that left the process table, so a recycled pid is never
  // escalated on sight.
  for (const pid of [...termSent]) {
    if (!rows.some((r) => r.pid === pid)) termSent.delete(pid);
  }

  if (awaitExitMs > 0 && sent.length > 0) {
    const deadline = Date.now() + awaitExitMs;
    while (Date.now() < deadline) {
      const alive = sent.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (alive.length === 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    console.warn('[codex-orphan] some orphans still exiting after SIGTERM; a resume right now may still hit the lock');
  }
}

/** pids this process has SIGTERM'd, for SIGKILL escalation on the next tick. */
const termSent = new Set<number>();
