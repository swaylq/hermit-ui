// orphan-pane-reaper.ts — kill `hermit-*` tmux panes that no ChatSession row
// accounts for (docs/session-cleanup-design.md).
//
// Every pane-killing path in this system is driven by a DB row: chatHibernateTick
// polls `hibernateRequestedAt`, the cleanup sweep archives the long-idle, and the
// reattach loop only ever iterates what `pollChatPending` returned. So deleting a
// session — which drops the row and leaves the pane running — produces a claude
// process that NOTHING can reap. `chat.deleteSession` used to claim these were
// "reclaimed on the next gateway restart"; they are not, because the gateway has
// no startup pane sweep either. Only a reboot or a hand-typed `tmux kill-session`
// ever got rid of one.
//
// Measured on mac001 2026-08-09: 13 orphan panes, idle 0.5–8.6 days, 1.54 GB of
// process-tree RSS on a 16 GB machine — ~10% of the host, permanently unreclaimable.
// The same shape as the macmini1 avalanche in docs/resource-governance-design.md,
// except the leak source is deletion rather than idleness.
//
// This also makes bulk session cleanup safe to build: without it, one click that
// deletes 45 sessions manufactures 45 orphans and turns a tidy-up into an incident.

import { listSessionsDetailed, tmuxPaneName, killTree, type TmuxSessionInfo } from '@hermit-ui/tmux-driver';
import { api } from './api';
import { paneIsWorking } from './pane';

// A pane must have been created AND been quiet longer than this to count as an
// orphan. Two clocks, not one: a pane spawned seconds ago whose row hasn't landed
// in the DB yet is indistinguishable from an orphan by membership alone, and its
// activity stamp is its own birth. Two hours is far longer than any create→sync
// window (the row exists BEFORE the pane is spawned; this is pure paranoia margin)
// and far shorter than the days these things actually accumulate for.
const ORPHAN_GRACE_MS = Number(process.env.HERMIT_ORPHAN_PANE_GRACE_MS ?? 2 * 60 * 60_000);

// Blast-radius cap per tick. An orphan set this large means something structural
// is wrong (a bad deploy, a machineId mismatch) and mass-killing panes is the
// worst possible response to a diagnosis you don't have yet.
const MAX_KILLS_PER_TICK = 10;

/**
 * Which panes to kill. Pure, and separated out on purpose: this is the function
 * that ends processes, so the rules it encodes should be assertable without a
 * tmux server, a dashboard, or a machine full of real sessions.
 *
 * Returns [] whenever the answer is "not sure" — an empty known-set is treated as
 * missing evidence, not as "nothing is known, so everything is an orphan".
 */
export function selectOrphanPanes(
  panes: TmuxSessionInfo[],
  knownSessionIds: string[],
  nowMs: number,
  graceMs = ORPHAN_GRACE_MS,
  cap = MAX_KILLS_PER_TICK,
): TmuxSessionInfo[] {
  // An empty known-set with live panes is ambiguous: it is either a machine whose
  // every session really was deleted, or a contract/scoping break that would have
  // us kill EVERY pane on the host. The first case costs one skipped tick and
  // resolves itself the moment any session exists; the second costs live work.
  if (knownSessionIds.length === 0) return [];

  // Compare by the pane NAME the driver would derive, so the "last 12 chars of the
  // cuid" rule lives in exactly one place (tmux-driver's paneName) instead of being
  // re-implemented — and wrong — here.
  const known = new Set(knownSessionIds.map((id) => tmuxPaneName(id)));
  return panes
    .filter((p) => !known.has(p.name) && nowMs - p.createdAt > graceMs && nowMs - p.activityAt > graceMs)
    // Oldest-quiet first: if the cap trims the batch, the panes most certainly
    // dead go first and the freshest ambiguous ones get another tick's grace.
    .sort((a, b) => a.activityAt - b.activityAt)
    .slice(0, cap);
}

export async function orphanPaneReaperTick(): Promise<void> {
  const panes = listSessionsDetailed('hermit-');
  if (panes.length === 0) return;

  let knownIds: string[];
  try {
    knownIds = (await api.knownSessions()).map((r) => r.id);
  } catch {
    return; // dashboard blip — never kill on a failed read
  }
  if (knownIds.length === 0) {
    console.warn(`[orphan-pane] ${panes.length} hermit pane(s) but the dashboard reports 0 sessions — skipping (refusing to mass-kill on an empty set)`);
    return;
  }

  const now = Date.now();
  const batch = selectOrphanPanes(panes, knownIds, now);
  if (batch.length === 0) return;
  if (batch.length === MAX_KILLS_PER_TICK) {
    console.warn(`[orphan-pane] killing ${batch.length} this tick (cap) — more may remain`);
  }

  let killed = 0;
  for (const p of batch) {
    // The pane name minus the prefix IS a valid argument to every pane function:
    // paneName() takes the last 12 chars of what it's given, and this string is
    // already exactly those 12 chars. No row exists to look a full id up from.
    const paneId = p.name.slice('hermit-'.length);
    // Re-check on the live pane. An orphan whose claude is mid-turn is still doing
    // work someone may be watching in tmux; let it finish and take it next tick.
    if (await paneIsWorking(paneId)) continue;
    // killTree, not kill(): a deleted session's pane has no DB row, but its
    // background shells (dev server, live-preview target) are just as orphaned
    // as the claude root — reap the whole subtree, not just the pane.
    await killTree(paneId, 2_000).catch(() => {});
    killed++;
    const idleH = ((now - p.activityAt) / 3.6e6).toFixed(1);
    console.log(`[orphan-pane] killed ${p.name} (no DB row, idle ${idleH}h)`);
  }
  if (killed > 0) console.log(`[orphan-pane] reaped ${killed} orphan pane(s)`);
}
