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
//   - ppid 1: the spawning gateway is gone (orphans reparent to launchd/systemd).
//     A live gateway's in-flight turn has the gateway as an ancestor, so a
//     restart-in-progress never kills the new incarnation's children.
//   - argv carries `mcp_servers.hermit`: only a hermit gateway passes that
//     config, so a human's terminal `codex` never matches.
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

/**
 * Which processes to kill. Pure and separate on purpose: the function that ends
 * processes should be assertable without a machine full of real orphans.
 */
export function selectCodexOrphans(
  rows: PsRow[],
  cap = MAX_KILLS_PER_TICK,
): PsRow[] {
  return rows
    .filter((r) =>
      r.ppid === 1 &&
      // The vendored binary's argv is `<…>/bin/codex exec …`; matching the
      // two together excludes `codex-code-mode-host` helpers and any other
      // codex subcommand.
      /\/bin\/codex exec /.test(r.command) &&
      r.command.includes('mcp_servers.hermit'),
    )
    .slice(0, cap);
}

/**
 * One sweep: find gateway-spawned codex execs whose gateway is dead and kill
 * them. Runs at startup (a restart's orphans exist from the first second) and
 * then periodically, in case a child outlives its turn some other way.
 */
export async function codexOrphanReaperTick(): Promise<void> {
  let out: string;
  try {
    out = execFileSync('ps', psAll('pid=,ppid=,command='), { encoding: 'utf8' });
  } catch {
    return; // ps failing is a host problem; never let the reaper crash the loop
  }
  for (const row of selectCodexOrphans(parsePs(out))) {
    try {
      process.kill(row.pid, 'SIGTERM');
      console.warn(`[codex-orphan] killed pid ${row.pid} (dead gateway's turn, holding its thread lock)`);
    } catch {
      // Already gone between ps and kill — the desired end state either way.
    }
  }
}
