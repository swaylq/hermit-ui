// "The message never left the dashboard."
//
// Every other health signal on this platform watches a PROCESS (gateway alive?,
// host red?, session working?). None of them watches the thing the human actually
// feels: they typed something and it never reached the machine. On 2026-08-26 a
// runaway batch job leaked 391 headless browsers on sway003-macmini (load 237,
// swap full) and the gateway's poll loop starved to 130–220s a tick — chat sat
// undelivered for ~6 hours while every process-level check stayed green enough.
// The human was the detector, six hours late.
//
// So the predicate here is about DELIVERY, not processes:
//
//     a message the human wrote is still waiting for the gateway to pick it up
//     (deliveredAt IS NULL), it is older than STUCK_MINUTES, and its session is
//     not provably busy right now (state='working' backed by a FRESH snapshotAt)
//
// The third clause is what keeps the bell honest, and it took two tries. First
// attempt had no clause: "queued behind a busy agent" is also undelivered — a
// follow-up sent mid-turn sits until the turn ends, 40+ minutes of perfectly
// healthy queueing, and the sweep fired on exactly that within minutes of
// deploying. Second attempt required the machine to have drained ANY message in
// the window — but cron prompts and replies never cross the outbound queue, so
// a quiet healthy machine acks nothing for hours and that excluded nothing.
// The honest discriminator is per-session: a session the gateway is actively
// working gets a session-snapshot push every ~8s, so state='working' with a
// snapshotAt under five minutes old is a genuinely busy agent and its queue is
// benign. Every other shape — idle, starting, hibernated, never-snapshotted,
// or "working" with a stale snapshot (a dead gateway freezes the word on the
// row) — must drain within seconds, so a 10-minute queue is the outage itself:
// the gateway dead, wedged, or starved. It is the same failure whichever of
// those it is, which is why this one signal covers the class — including the
// shapes the host red-zone cannot see (a wedged event loop stops host-stat
// pushes too; the row just goes stale, and stale raises nothing).
//
// This module is also the home of the MachineAlert ledger itself. Three writers:
//   - the sweep below (kind 'stuck-messages') — owns the full lifecycle, resolves
//     its own alerts when the queue drains;
//   - POST /api/sync/machine-alert (the on-host watchdog and gateway ticks) —
//     episodic kinds that carry a TTL and lapse when the reporter goes quiet;
//   - the banner's dismiss button (alerts.dismiss) — the human closing one by hand.
//
// Threshold and cadence: STUCK_MINUTES defaults to 10 (detection at 10–11 min at
// the 1-minute sweep). Compare the unanswered sweep at 30 min: "nobody replied"
// has benign causes (agent busy on a long turn); "never delivered" has none.

import { prisma } from './db';
import { enqueuePush } from './push';
import { machineAlertClearedEvent, machineAlertEvent, machineAlertFailureEvent } from './push/events';
import { watchdogConfigOf } from '@/lib/watchdog-config';

/** Default when a machine has no watchdogConfig row (Settings → Watchdogs can
 *  tighten or loosen it per machine). */
export const STUCK_MINUTES = clampMinutes(process.env.STUCK_ALERT_MINUTES, 10);

/** How often to look. 1 minute: this predicate is near-zero false-positive. */
export const SWEEP_INTERVAL_MS = 60_000;

/** Re-push at most this often while one (machine, kind) condition keeps holding. */
const REPUSH_MS = 30 * 60_000;

/** A dismiss silences that (machine, kind) for this long, even if the condition
 *  persists — otherwise the sweep re-opens it on the next pass and × is decorative. */
const DISMISS_SNOOZE_MS = 4 * 60 * 60_000;

/** At most one "the check itself is broken" push per hour, however often it fails. */
const FAILURE_PUSH_INTERVAL_MS = 60 * 60_000;

function clampMinutes(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── The alert ledger ─────────────────────────────────────────────────────────

/** "Open" = not dismissed/resolved, and not lapsed past its TTL. */
function openWhere(now: Date) {
  return {
    resolvedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

/**
 * Raise (or refresh) an alert for a machine. One open row per (machineId, kind):
 * a repeat occurrence updates message/count/expiresAt instead of stacking rows,
 * and re-pushes at most every REPUSH_MS. Pushes happen on the TRANSITION to open
 * (pushedAt null) or after the throttle — never per sweep/tick.
 *
 * A (machine, kind) the human dismissed inside DISMISS_SNOOZE_MS is left alone:
 * the dismissed row's message/count are refreshed (so an unsnooze later reads
 * true) but nothing re-opens and nothing pushes.
 *
 * `ttlMs` null = a condition alert whose lifecycle the caller owns (it must call
 * resolveAlerts when the condition clears). Non-null = an episodic report that
 * lapses on its own when the reporter stops re-reporting.
 *
 * Returns what happened, so callers can count honestly: 'created' | 'updated'
 * (includes re-pushes of a held condition) | 'snoozed'.
 */
export async function openAlert(args: {
  machineId: string;
  machineName?: string;
  kind: string;
  message: string;
  count?: number;
  ttlMs: number | null;
  push?: boolean;
  /** Where tapping the banner / push lands. */
  linkPath?: string | null;
}): Promise<'created' | 'updated' | 'snoozed'> {
  const now = new Date();
  const expiresAt = args.ttlMs == null ? null : new Date(now.getTime() + args.ttlMs);
  const existing = await prisma.machineAlert.findFirst({
    where: { machineId: args.machineId, kind: args.kind, ...openWhere(now) },
  });

  const shouldPush =
    args.push !== false &&
    (!existing?.pushedAt || now.getTime() - existing.pushedAt.getTime() >= REPUSH_MS);

  if (existing) {
    await prisma.machineAlert.update({
      where: { id: existing.id },
      data: {
        message: args.message,
        count: args.count ?? 1,
        linkPath: args.linkPath ?? existing.linkPath,
        expiresAt: args.ttlMs == null ? existing.expiresAt : expiresAt,
        ...(shouldPush ? { pushedAt: now } : {}),
      },
    });
  } else {
    // Snoozed? A dismissed row for this (machine, kind) whose quiet period is
    // still running. Refresh its facts but keep it resolved and silent.
    const snoozed = await prisma.machineAlert.findFirst({
      where: {
        machineId: args.machineId,
        kind: args.kind,
        snoozedUntil: { gt: now },
      },
    });
    if (snoozed) {
      await prisma.machineAlert.update({
        where: { id: snoozed.id },
        data: { message: args.message, count: args.count ?? 1 },
      });
      return 'snoozed';
    }
    await prisma.machineAlert.create({
      data: {
        machineId: args.machineId,
        kind: args.kind,
        message: args.message,
        count: args.count ?? 1,
        linkPath: args.linkPath ?? null,
        expiresAt,
        pushedAt: shouldPush ? now : null,
      },
    });
  }

  if (shouldPush) {
    const machine = await prisma.machine.findUnique({ where: { id: args.machineId } });
    const machineName = args.machineName ?? machine?.alias?.trim() ?? machine?.name ?? args.machineId;
    enqueuePush(
      machineAlertEvent({
        machineId: args.machineId,
        machineName,
        kind: args.kind,
        message: args.message,
        linkPath: args.linkPath,
      }),
    );
  }
  return existing ? 'updated' : 'created';
}

/** Resolve every open alert of a kind on a machine (condition cleared). */
export async function resolveAlerts(machineId: string, kind: string): Promise<number> {
  const now = new Date();
  const open = await prisma.machineAlert.findMany({
    where: { machineId, kind, ...openWhere(now) },
    select: { id: true, pushedAt: true },
  });
  if (open.length === 0) return 0;
  const r = await prisma.machineAlert.updateMany({
    where: { id: { in: open.map((a) => a.id) } },
    data: { resolvedAt: now },
  });

  // A stale push never leaves the lock screen on its own: the same collapseKey
  // must carry the "it's over" note, or last night's false alarm sits there
  // forever (2026-08-26 — the human reported exactly that). Only alert kinds
  // that actually pushed need the clearing one.
  if (open.some((a) => a.pushedAt)) {
    const machine = await prisma.machine.findUnique({ where: { id: machineId } });
    enqueuePush(
      machineAlertClearedEvent({
        machineId,
        machineName: machine?.alias?.trim() || machine?.name || machineId,
        kind,
      }),
    );
  }
  return r.count;
}

/** Open alerts across the fleet (the banner). Newest first. */
export async function listOpen(machineId: string) {
  const now = new Date();
  return prisma.machineAlert.findMany({
    where: { machineId, ...openWhere(now) },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
}

/** The human closed one by hand — resolved, and quiet for DISMISS_SNOOZE_MS. */
export async function dismiss(machineId: string, id: string): Promise<void> {
  const now = new Date();
  await prisma.machineAlert.updateMany({
    where: { id, machineId, resolvedAt: null },
    data: { resolvedAt: now, snoozedUntil: new Date(now.getTime() + DISMISS_SNOOZE_MS) },
  });
}

// ── The stuck-message sweep ──────────────────────────────────────────────────

export interface StuckRow {
  machineId: string;
  machineName: string;
  n: number;
  oldest: Date;
  oldestSessionId: string;
  oldestAgentName: string;
}

/**
 * Human messages still waiting for the gateway, grouped by machine, excluding
 * messages whose session is provably busy (state='working' with a snapshotAt
 * fresher than five minutes — the gateway pushes session snapshots every ~8s,
 * so a fresh one is proof the working claim is current and the queue is just a
 * busy agent's backlog). A stale "working" is not trusted: a dead gateway
 * freezes the word on the row, which is exactly the case this must catch.
 *
 * The human-wrote-it clauses match the unanswered sweep exactly (role='user',
 * authoredBy NULL, externalId NULL — a synced-back tool_result and a Brain
 * takeover line are both role 'user' and neither is the human typing), plus
 * deliveredAt NULL and a session that is not closed, trashed, or a
 * Brain/agent-dispatched conversation.
 */
export async function findStuck(now: Date, thresholdMs: number): Promise<StuckRow[]> {
  const cutoff = new Date(now.getTime() - thresholdMs);
  return prisma.$queryRaw<StuckRow[]>`
    SELECT s."machineId"                    AS "machineId",
           COALESCE(NULLIF(mac.alias, ''), mac.name) AS "machineName",
           COUNT(*)::int                    AS "n",
           MIN(m."createdAt")               AS "oldest",
           (ARRAY_AGG(m."sessionId" ORDER BY m."createdAt"))[1]  AS "oldestSessionId",
           (ARRAY_AGG(s."agentName" ORDER BY m."createdAt"))[1]  AS "oldestAgentName"
    FROM "ChatMessage" m
    JOIN "ChatSession" s ON s.id = m."sessionId"
    JOIN "Machine" mac ON mac.id = s."machineId"
    WHERE m.role = 'user'
      AND m."authoredBy" IS NULL
      AND m."externalId" IS NULL
      AND m."deliveredAt" IS NULL
      AND m."createdAt" < ${cutoff}
      AND s."closedAt" IS NULL
      AND s."trashedAt" IS NULL
      AND s.origin IS NULL
      AND NOT (s.state = 'working' AND s."snapshotAt" > ${new Date(now.getTime() - 5 * 60_000)})
    GROUP BY s."machineId", mac.alias, mac.name
  `;
}

export interface SweepResult {
  /** Machines currently over threshold (including ones already alerting). */
  stuck: number;
  /** Alerts newly opened this sweep. */
  raised: number;
  /** Alerts resolved because the queue drained. */
  cleared: number;
}

/**
 * One pass. Raises on the TRANSITION into stuck (openAlert dedups), and resolves
 * the moment the gateway drains the queue — a delivery recovery is visible in
 * the same banner without anyone clicking anything.
 *
 * Throws rather than reporting a clean sweep when it cannot see the world —
 * a monitor that reports "all clear" while blind is worse than no monitor.
 */
export async function sweepOnce(now: Date = new Date()): Promise<SweepResult> {
  // Per-machine knobs (Settings → Watchdogs): the tightest enabled threshold is
  // the query cutoff; each machine's own threshold then filters its row. A
  // machine with the watchdog off is skipped entirely.
  const machines = await prisma.machine.findMany({
    select: { id: true, watchdogConfig: true },
  });
  const cfgByMachine = new Map(machines.map((m) => [m.id, watchdogConfigOf(m).stuck]));
  const enabledMinutes = [...cfgByMachine.values()].filter((c) => c.enabled).map((c) => c.minutes);

  const sessionCount = await prisma.chatSession.count();
  if (sessionCount === 0) {
    throw new Error('stuck sweep sees zero chat sessions — refusing to report a clean sweep');
  }
  if (enabledMinutes.length === 0) {
    return { stuck: 0, raised: 0, cleared: 0 }; // every machine switched this watchdog off
  }

  const rows = (await findStuck(now, Math.min(...enabledMinutes) * 60_000)).filter((r) => {
    const cfg = cfgByMachine.get(r.machineId);
    if (!cfg?.enabled) return false;
    return now.getTime() - r.oldest.getTime() >= cfg.minutes * 60_000;
  });
  const stuckMachines = new Set(rows.map((r) => r.machineId));

  let raised = 0;
  for (const row of rows) {
    const oldestMin = Math.round((now.getTime() - row.oldest.getTime()) / 60_000);
    const outcome = await openAlert({
      machineId: row.machineId,
      machineName: row.machineName,
      kind: 'stuck-messages',
      message: `${row.n} 条消息超过 ${oldestMin} 分钟未被网关取走（最老一条发给 ${row.oldestAgentName}）`,
      count: row.n,
      ttlMs: null,
      linkPath: `/chat?session=${row.oldestSessionId}`,
    });
    if (outcome === 'created') raised++;
  }

  // Resolve open stuck alerts on machines no longer over threshold.
  const openStuck = await prisma.machineAlert.findMany({
    where: { kind: 'stuck-messages', ...openWhere(now) },
    select: { machineId: true },
  });
  let cleared = 0;
  for (const a of openStuck) {
    if (stuckMachines.has(a.machineId)) continue;
    cleared += await resolveAlerts(a.machineId, 'stuck-messages');
  }

  return { stuck: rows.length, raised, cleared };
}

// ── Runner ──────────────────────────────────────────────────────────────────
//
// Process-local, like the unanswered sweep: the dashboard runs as a single pm2
// fork, so exactly one sweep exists.

export interface SweepHealth {
  lastOkAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  running: boolean;
}

const health: SweepHealth = { lastOkAt: null, lastError: null, consecutiveFailures: 0, running: false };
let timer: NodeJS.Timeout | null = null;
let lastFailurePushAt = 0;

export function stuckSweepHealth(): SweepHealth {
  return { ...health };
}

async function tick(): Promise<void> {
  try {
    const r = await sweepOnce();
    health.lastOkAt = new Date();
    health.lastError = null;
    health.consecutiveFailures = 0;
    if (r.raised > 0 || r.cleared > 0) {
      console.log(`[stuck] sweep: ${r.stuck} machine(s) stuck, ${r.raised} raised, ${r.cleared} cleared`);
    }
  } catch (e) {
    // Never let a bad tick take the interval down with it.
    health.consecutiveFailures++;
    health.lastError = e instanceof Error ? e.message : String(e);
    console.error(`[stuck] sweep failed (${health.consecutiveFailures}x): ${health.lastError}`);
    await pushFailure(health.lastError, health.consecutiveFailures);
  }
}

/** Tell someone the check itself is broken — at most hourly, to every machine. */
async function pushFailure(message: string, failures: number): Promise<void> {
  const now = Date.now();
  if (now - lastFailurePushAt < FAILURE_PUSH_INTERVAL_MS) return;
  lastFailurePushAt = now;
  try {
    const machines = await prisma.machine.findMany({ select: { id: true } });
    for (const m of machines) {
      enqueuePush(machineAlertFailureEvent({ machineId: m.id, message, failures }));
    }
  } catch {
    // If even the machine list is unreachable the log line above is all there is.
  }
}

/**
 * Start the sweep. Idempotent, and a no-op when `STUCK_ALERT_DISABLED` is set —
 * the off switch is an env var at the host, not a click.
 */
export function startStuckMessageSweep(): void {
  if (timer) return;
  if (process.env.STUCK_ALERT_DISABLED) {
    console.log('[stuck] disabled by STUCK_ALERT_DISABLED');
    return;
  }
  health.running = true;
  console.log(
    `[stuck] watching for human messages undelivered > ${STUCK_MINUTES}min, every ${SWEEP_INTERVAL_MS / 60_000}min`,
  );
  timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  // First pass 90s after boot: a deploy restart happens while gateways are
  // reconnecting and their in-flight acks should land before anything is judged.
  const first = setTimeout(() => void tick(), 90_000);
  first.unref?.();
}

/** Tests / shutdown. */
export function stopStuckMessageSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
  health.running = false;
}
