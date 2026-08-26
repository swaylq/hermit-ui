// "Someone asked, and nobody answered."
//
// Every other signal this platform collects reports whether a session is ALIVE or
// BUSY. None of them report whether a conversation owes the human a reply — which is
// why a live, idle-looking session swallowed `查看为什么线上挂了` on 2026-07-31 and sat
// on it for 188 minutes while the site stayed down. `alive: true, state: "idle"` is
// the same row for "healthy and between tasks" and "three hours late".
//
// So the predicate is about the CONVERSATION, not the process:
//
//     the newest message in the session is one the human typed,
//     and it is older than UNANSWERED_MINUTES
//
// Deliberately blind to `state` / `alive` / pane text: those are the signals that
// lied, and gating on "…and it looks idle" would have suppressed the other half of
// the blind spot (a rejected oversized paste leaves a session that looks busy
// forever). They ride along in the alert body for triage; they are never in the test.
//
// Threshold and sweep cadence are measured, not guessed — see
// docs/unanswered-alert-design.md for the 61-day distribution behind T = 30 min.

import { prisma } from './db';
import { enqueuePush } from './push';
import { unansweredEvent, unansweredFailureEvent } from './push/events';
import { watchdogConfigOf } from '@/lib/watchdog-config';

/** How long the human's message may sit unanswered before it's an alert. */
export const UNANSWERED_MINUTES = clampMinutes(process.env.UNANSWERED_ALERT_MINUTES, 30);

/**
 * How often to look. Detection lands at T..T+SWEEP — 30–35 min at the defaults.
 * Anything faster buys minutes on a 30-minute threshold and costs a scan.
 */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * The prefilter (`lastMessageAt` older than T minus this) is a cheap index range on
 * (machineId, lastMessageAt); the exact test then runs on the message row itself. The
 * slack absorbs any skew between a session's lastMessageAt stamp and its newest
 * message, so the prefilter can only ever over-include.
 */
const PREFILTER_SLACK_MS = 5 * 60_000;

/** At most one "the check itself is broken" push per hour, however often it fails. */
const FAILURE_PUSH_INTERVAL_MS = 60 * 60_000;

function clampMinutes(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The newest message in a session, plus the session fields the alert needs. */
export interface LastMessageRow {
  sessionId: string;
  machineId: string;
  agentName: string;
  title: string | null;
  unansweredMsgId: string | null;
  /** Runtime state, carried for triage only — never part of the decision. */
  state: string | null;
  alive: boolean;
  msgId: string;
  role: string;
  authoredBy: string | null;
  externalId: string | null;
  createdAt: Date;
  content: unknown;
}

/**
 * Did the HUMAN write this row? The same four-clause definition the USER-PROFILE
 * corpus rests on (server/user-profile.ts) — `role='user'` alone is a trap, since a
 * synced-back `tool_result` and an image the agent Read mid-task are both role 'user'
 * in Anthropic's format, and the Brain's takeover messages are role 'user' too.
 * (The fourth clause, `session.origin IS NULL`, is enforced in the query: a whole
 * Brain-dispatch conversation is never the human waiting.)
 */
export function isHumanRow(row: Pick<LastMessageRow, 'role' | 'authoredBy' | 'externalId'>): boolean {
  return row.role === 'user' && row.authoredBy === null && row.externalId === null;
}

/** The predicate itself, kept pure so the thing that decides can be tested directly. */
export function isUnanswered(row: LastMessageRow, now: Date, thresholdMs: number): boolean {
  return isHumanRow(row) && now.getTime() - row.createdAt.getTime() >= thresholdMs;
}

/**
 * Sessions whose newest message is the human's, older than the threshold.
 *
 * One round trip: a LATERAL "newest row per session" over sessions the prefilter
 * already narrowed. Prisma can't express LATERAL, and the obvious alternatives are
 * both traps the inbox already hit — a `distinct: ['sessionId']` pulls whole message
 * histories into memory, and one findFirst per session is ~190 round trips a tick.
 */
export async function findUnanswered(now: Date, thresholdMs: number): Promise<LastMessageRow[]> {
  const prefilterCutoff = new Date(now.getTime() - Math.max(0, thresholdMs - PREFILTER_SLACK_MS));
  const rows = await prisma.$queryRaw<LastMessageRow[]>`
    SELECT s.id            AS "sessionId",
           s."machineId"   AS "machineId",
           s."agentName"   AS "agentName",
           s.title         AS "title",
           s."unansweredMsgId" AS "unansweredMsgId",
           s.state         AS "state",
           s.alive         AS "alive",
           m.id            AS "msgId",
           m.role          AS "role",
           m."authoredBy"  AS "authoredBy",
           m."externalId"  AS "externalId",
           m."createdAt"   AS "createdAt",
           m.content       AS "content"
    FROM "ChatSession" s
    JOIN LATERAL (
      SELECT id, role, "authoredBy", "externalId", "createdAt", content
      FROM "ChatMessage"
      WHERE "sessionId" = s.id
      ORDER BY "createdAt" DESC, id DESC
      LIMIT 1
    ) m ON TRUE
    WHERE s."closedAt" IS NULL
      AND s."trashedAt" IS NULL
      AND s.origin IS NULL
      AND s."lastMessageAt" IS NOT NULL
      AND s."lastMessageAt" < ${prefilterCutoff}
  `;
  return rows.filter((r) => isUnanswered(r, now, thresholdMs));
}

export interface SweepResult {
  /** Sessions currently in the unanswered state (including ones already flagged). */
  unanswered: number;
  /** Newly flagged this sweep — the ones that pushed. */
  raised: number;
  /** Flags dropped because the conversation moved on. */
  cleared: number;
}

/**
 * One pass. Raises on the TRANSITION into unanswered (so a session stuck for six
 * hours pushes once, not seventy-two times) and clears the flag the moment any
 * non-human row lands.
 *
 * Throws rather than returning a clean sweep when it can't see the world it is
 * supposed to be watching — a monitor that reports "all clear" while blind is worse
 * than no monitor. Callers must treat a throw as an alert, not a retry.
 */
export async function sweepOnce(now: Date = new Date()): Promise<SweepResult> {
  // Per-machine knobs (Settings → Watchdogs): the tightest enabled threshold is
  // the query cutoff, each machine's own threshold then decides its rows, and a
  // machine with the watchdog off is skipped. Machines without a row get
  // UNANSWERED_MINUTES (30) via the defaults in lib/watchdog-config.ts.
  const machines = await prisma.machine.findMany({ select: { id: true, watchdogConfig: true } });
  const cfgByMachine = new Map(machines.map((m) => [m.id, watchdogConfigOf(m).unanswered]));
  const enabledMinutes = [...cfgByMachine.values()].filter((c) => c.enabled).map((c) => c.minutes);
  const thresholdMs = (enabledMinutes.length ? Math.min(...enabledMinutes) : UNANSWERED_MINUTES) * 60_000;

  // Fail-closed guard: an empty result set has two very different causes, and only
  // one of them is good news. If sessions exist to watch, "nothing stalled" is a
  // finding; if the query can see no sessions at all, it is a blindfold.
  const sessionCount = await prisma.chatSession.count();
  if (sessionCount === 0) {
    throw new Error('unanswered sweep sees zero chat sessions — refusing to report a clean sweep');
  }

  const [rawRows, flagged] = await Promise.all([
    findUnanswered(now, thresholdMs),
    prisma.chatSession.findMany({
      where: { unansweredMsgId: { not: null }, trashedAt: null },
      select: { id: true, unansweredMsgId: true },
    }),
  ]);
  const rows = rawRows.filter((r) => {
    const cfg = cfgByMachine.get(r.machineId);
    if (!cfg?.enabled) return false;
    return isUnanswered(r, now, cfg.minutes * 60_000);
  });

  const stillUnanswered = new Map(rows.map((r) => [r.sessionId, r.msgId]));

  // Clear first: a session whose flagged message is no longer the last word has been
  // answered (or archived, or superseded by a newer human message that will re-raise
  // on its own clock).
  let cleared = 0;
  for (const f of flagged) {
    if (stillUnanswered.get(f.id) === f.unansweredMsgId) continue;
    await prisma.chatSession.update({
      where: { id: f.id },
      data: { unansweredMsgId: null, unansweredAckedMsgId: null },
    });
    cleared++;
  }

  let raised = 0;
  for (const row of rows) {
    if (row.unansweredMsgId === row.msgId) continue; // already alerted on this one
    await prisma.chatSession.update({
      where: { id: row.sessionId },
      data: { unansweredMsgId: row.msgId, unansweredAckedMsgId: null },
    });
    enqueuePush(
      unansweredEvent({
        machineId: row.machineId,
        sessionId: row.sessionId,
        agentName: row.agentName,
        content: row.content,
        waitedMinutes: Math.round((now.getTime() - row.createdAt.getTime()) / 60_000),
        state: row.alive ? (row.state ?? 'unknown') : 'pane gone',
      }),
    );
    raised++;
    console.log(
      `[unanswered] ${row.agentName} — no reply for ${Math.round(
        (now.getTime() - row.createdAt.getTime()) / 60_000,
      )}min (session ${row.sessionId}, alive=${row.alive}, state=${row.state ?? '—'})`,
    );
  }

  return { unanswered: rows.length, raised, cleared };
}

// ── Runner ──────────────────────────────────────────────────────────────────
//
// Process-local, like the push debounce map: the dashboard runs as a single pm2 fork
// (ecosystem.config.cjs, no cluster), so exactly one sweep exists.

export interface SweepHealth {
  lastOkAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  running: boolean;
}

const health: SweepHealth = { lastOkAt: null, lastError: null, consecutiveFailures: 0, running: false };
let timer: NodeJS.Timeout | null = null;
let lastFailurePushAt = 0;

export function unansweredHealth(): SweepHealth {
  return { ...health };
}

async function tick(): Promise<void> {
  try {
    const r = await sweepOnce();
    health.lastOkAt = new Date();
    health.lastError = null;
    health.consecutiveFailures = 0;
    if (r.raised > 0 || r.cleared > 0) {
      console.log(`[unanswered] sweep: ${r.unanswered} unanswered, ${r.raised} raised, ${r.cleared} cleared`);
    }
  } catch (e) {
    // Never let a bad tick take the interval down with it — a monitor that dies
    // quietly is the failure this whole feature exists to prevent.
    health.consecutiveFailures++;
    health.lastError = e instanceof Error ? e.message : String(e);
    console.error(`[unanswered] sweep failed (${health.consecutiveFailures}x): ${health.lastError}`);
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
    for (const m of machines) enqueuePush(unansweredFailureEvent({ machineId: m.id, message, failures }));
  } catch {
    // If even the machine list is unreachable the log line above is all there is.
  }
}

/**
 * Start the sweep. Idempotent, and a no-op when `UNANSWERED_ALERT_DISABLED` is set —
 * the off switch is an env var rather than a settings toggle because turning off the
 * alarm should be a deliberate act at the host, not a click.
 */
export function startUnansweredSweep(): void {
  if (timer) return;
  if (process.env.UNANSWERED_ALERT_DISABLED) {
    console.log('[unanswered] disabled by UNANSWERED_ALERT_DISABLED');
    return;
  }
  health.running = true;
  console.log(
    `[unanswered] watching for messages unanswered > ${UNANSWERED_MINUTES}min, every ${SWEEP_INTERVAL_MS / 60_000}min`,
  );
  timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  // First pass shortly after boot rather than immediately: a deploy restart happens
  // while gateways are reconnecting, and their in-flight message sync should land
  // before anything is judged unanswered.
  const first = setTimeout(() => void tick(), 60_000);
  first.unref?.();
}

/** Tests / shutdown. */
export function stopUnansweredSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
  health.running = false;
}
