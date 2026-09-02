// orphan-child-reaper.ts — kill the agent children a DEAD gateway left behind,
// before they collide with the ones the new gateway is about to start.
//
// Why this exists (2026-08-29, mac-local): a gateway restart orphaned the
// in-flight turn's codex exec (it is a grandchild of pm2, not killed with the
// gateway). Codex's thread store keeps an "active writer" lock per thread, so
// the new gateway's resume of that thread died with
// `thread-store conflict: thread … already has an active writer` and the user's
// message produced nothing but `[codex could not run this turn]`. The orphan
// also kept burning the plan for nearly three hours — nobody was watching it.
//
// It covers claude-sdk too since 2026-09-02, for a reason that did not exist
// before: `treekill: false` in ecosystem.config.cjs. pm2 used to signal the
// whole subtree, so a claude child could never outlive its gateway no matter
// how the gateway died. Now the first signal goes to the gateway alone — which
// is what makes a graceful drain possible at all — and the price is that a
// gateway pm2 has to SIGKILL leaves its claude children running. Two Claude
// Codes appending to one `<uuid>.jsonl` is the failure the pane era took three
// incidents to learn to prevent; this is what keeps that from coming back in a
// new costume.
//
// Every signature is two conditions, both required:
//   - ppid 1: the spawning gateway is gone (orphans reparent to launchd, and to
//     pid 1 under pm2 on Linux too — pm2 never sets CHILD_SUBREAPER, measured
//     on dgx-spark). A live gateway's in-flight turn has the gateway as an
//     ancestor, so a restart-in-progress never kills the new incarnation's
//     children. This also keeps the reaper correct once a session-host process
//     owns the children: theirs have the host as parent, not init.
//   - an argv marker only a hermit gateway produces, so a human's own terminal
//     session in the same directory is never touched.
//
// NOT covered, deliberately: kimi and dsh. Their hermit markers live in the
// ENVIRONMENT (HERMIT_DSH_TASK_FILE, HERMIT_KEY), not in argv, so identifying
// them means a second `ps eww` per candidate — and getting it wrong means
// killing a person's own kimi. The shutdown drain now calls `stop()` on every
// backend, so their orphans are prevented at the source; what remains uncovered
// is only the SIGKILL path. Worth revisiting if that path ever bites.
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

/** The codex signature, on one parsed ps row. */
export function isCodexOrphan(r: PsRow): boolean {
  return (
    r.ppid === 1 &&
    // The vendored binary's argv is `<…>/bin/codex exec …`; matching the two
    // together excludes `codex-code-mode-host` helpers and other subcommands.
    /\/bin\/codex exec /.test(r.command) &&
    r.command.includes('mcp_servers.hermit')
  );
}

/**
 * The claude-sdk signature.
 *
 * NOT `mcp-stub.cjs` alone, which is what this matched first and was wrong in a
 * way that mattered: that path only appears in the `--mcp-config` blob when
 * `hermitTools` is on, and an ordinary (non-orchestrator) cron turn is spawned
 * with `hermitTools: false` and no mcpServers at all (runtime/cron-turn.ts). So
 * exactly the turns nobody is watching — the scheduled ones — were the turns
 * whose orphans were never reaped.
 *
 * What every claude-sdk spawn does have, unconditionally, is the SDK's
 * stream-json pair plus this gateway's own three options: bypassPermissions,
 * partial messages, and a session id it either minted or is resuming. Together
 * they exclude the two things that must never be touched:
 *   • a human's terminal claude, which has none of them;
 *   • the tmux-pane backend, which runs the same binary interactively and is
 *     SUPPOSED to outlive a gateway — reaping a pane would delete the one
 *     property it exists for.
 *
 * Not matched on the binary path: `resolveClaudeBin()` returns whatever this
 * machine has, and pinning a path is how the codex signature got its known gap.
 *
 * Known imprecision, accepted: another Agent SDK application on this machine,
 * running with bypassPermissions and orphaned, would match. Weighed against
 * missing every scheduled turn's orphan — which is the incident this file was
 * written for, one backend along — that is the better error to make.
 */
export function isClaudeSdkOrphan(r: PsRow): boolean {
  if (r.ppid !== 1) return false;
  const c = r.command;
  if (!c.includes('--input-format stream-json') || !c.includes('--output-format stream-json')) return false;
  // The strongest marker when it is there, but it is not always there.
  if (c.includes('mcp-stub.cjs')) return true;
  return (
    c.includes('--permission-mode bypassPermissions') &&
    c.includes('--include-partial-messages') &&
    (/--session-id[= ]/.test(c) || /--resume[= ]/.test(c))
  );
}

interface Signature {
  backend: string;
  match(r: PsRow): boolean;
  /** Printed with the kill, so a log line says why this process had to go. */
  why: string;
}

const SIGNATURES: Signature[] = [
  { backend: 'codex', match: isCodexOrphan, why: "dead gateway's turn, holding its thread lock" },
  { backend: 'claude-sdk', match: isClaudeSdkOrphan, why: "dead gateway's child, would double-write its transcript" },
];

export interface KillPlan {
  pid: number;
  signal: 'SIGTERM' | 'SIGKILL';
  backend: string;
  why: string;
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
  const orphans: Array<{ row: PsRow; sig: Signature }> = [];
  for (const row of rows) {
    // First match wins: the signatures are disjoint by construction (different
    // binaries), and a row matching two of them would mean one of them is wrong
    // — killing it twice would not make it more dead.
    const sig = SIGNATURES.find((s) => s.match(row));
    if (sig) orphans.push({ row, sig });
  }
  const kills = orphans.slice(0, cap).map(({ row, sig }) => ({
    pid: row.pid,
    signal: (termSent.has(row.pid) ? 'SIGKILL' : 'SIGTERM') as 'SIGTERM' | 'SIGKILL',
    backend: sig.backend,
    why: sig.why,
  }));
  return { kills, overflow: Math.max(0, orphans.length - kills.length) };
}

/**
 * One sweep: find agent children whose gateway is dead and kill them. Runs at
 * startup (a restart's orphans exist from the first second — pass awaitExitMs
 * there so nothing resumes into a still-held lock or a still-open transcript)
 * and then periodically, in case a child outlives its turn some other way.
 */
export async function orphanChildReaperTick(awaitExitMs = 0): Promise<void> {
  let out: string;
  try {
    out = execFileSync('ps', psAll('pid=,ppid=,command='), { encoding: 'utf8' });
  } catch {
    return; // ps failing is a host problem; never let the reaper crash the loop
  }
  const rows = parsePs(out);
  const { kills, overflow } = planKills(rows, termSent);
  if (overflow > 0) {
    console.warn(`[orphan-child] ${overflow} more orphan(s) beyond the per-tick cap, next tick gets them`);
  }
  const sent: number[] = [];
  for (const kill of kills) {
    try {
      process.kill(kill.pid, kill.signal);
      sent.push(kill.pid);
      if (kill.signal === 'SIGKILL') {
        console.warn(`[orphan-child] ${kill.backend} pid ${kill.pid} ignored SIGTERM last tick, sent SIGKILL`);
      } else {
        termSent.add(kill.pid);
        console.warn(`[orphan-child] SIGTERM ${kill.backend} pid ${kill.pid} (${kill.why})`);
      }
    } catch (e) {
      // ESRCH: already gone between ps and kill — the desired end state.
      // Anything else (EPERM on a multi-user box, say) must be LOUD: a silent
      // failure here is exactly the wedge this file exists to prevent.
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.warn(`[orphan-child] kill pid ${kill.pid} failed:`, e);
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
    console.warn('[orphan-child] some orphans still exiting after SIGTERM; a resume right now may still hit a held lock or an open transcript');
  }
}

/** pids this process has SIGTERM'd, for SIGKILL escalation on the next tick. */
const termSent = new Set<number>();
