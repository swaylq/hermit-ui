// Deciding which chat sessions can be cleaned up, and how far.
//
// See docs/session-cleanup-design.md. Two ideas carry the whole file:
//
// 1. A session is safe to clean when NOTHING still points at it and NOBODY is
//    still waiting on it. A session is a referenced object here — a cron reports
//    into it, the Brain dispatches through it, an interaction blocks on it — so
//    "safe" is a question about inbound edges, not about age. Age only decides
//    whether the question is worth asking. `BLOCKERS` below is the complete set
//    of those edges as of this schema; adding a new reference to ChatSession
//    means adding a blocker here, or cleanup will silently break it.
//
// 2. Cleaning is a LADDER, not a switch. Sleep (frees the process), archive
//    (frees the sidebar), trash (frees the mind, recoverable), purge (frees the
//    bytes, irreversible) differ by an order of magnitude in reversibility, so a
//    session lands on the LIGHTEST rung its evidence supports rather than all of
//    them landing on the same one. That is what makes a one-click sweep sane.
//
// Nothing here writes. It reads a machine's sessions and returns a verdict per
// session; the router decides what to do with that, and the irreversible rung
// never happens without a human confirming the list.

import { prisma } from './db';
import { USER_QUEUE_FILTER } from '../lib/chat-queue';

/**
 * Spread into any ChatSession `where` that feeds a list, a count, a notification
 * or the gateway: a session in the recycle bin must be invisible and inert
 * everywhere, or "trashed" would mean "still rings, still respawns, still counts".
 *
 * Deliberately NOT applied to point lookups by id (the SSE stream, upload,
 * transcribe, interaction sync): those already have a session the caller is
 * holding, and failing them mid-flight turns a tidy-up into a broken request.
 * The bin is a visibility boundary, not an authorization one.
 */
export const LIVE_SESSION = { trashedAt: null } as const;

// A session must be quiet at least this long before ANY tier is considered.
// Measured on mac001 (2026-08-09, 125 sessions): >7d catches 71 of them, but 32
// of those are still awake and inside a normal working rhythm; >30d catches 30,
// which is the tail that never comes back. 14d is where the set stops containing
// things people are mid-way through.
export const DEFAULT_ARCHIVE_IDLE_DAYS = 14;
export const DEFAULT_TRASH_IDLE_DAYS = 30;

// Cap on one sweep. A run bigger than this is either a first-ever cleanup on a
// long-neglected machine or a bug, and both are better served by doing 50, saying
// so, and letting the human look at the result before the next batch.
export const MAX_PER_RUN = 50;

/**
 * Lightest-to-heaviest. `keep` means the session was examined and left alone.
 *
 * There used to be a `sleep` rung between keep and archive, for sessions that were
 * awake but quiet, mirroring a second automatic mechanism (the idle-TTL reaper).
 * Both are gone. Hibernating and archiving were never distinct enough as CONCEPTS
 * to earn two rows and two thresholds, and running both produced the one state
 * nobody wants: a sleeping session still sitting in the sidebar looking normal.
 * Archiving now hibernates as part of archiving, which is what anyone would assume
 * it did — a conversation that has left the sidebar has no business holding a
 * ~500MB process. See migration 20260809210000_retire_idle_reaper.
 */
export type CleanupTier = 'keep' | 'archive' | 'trash';

export interface CleanupVerdict {
  id: string;
  agentName: string;
  title: string | null;
  preview: string | null;
  lastMessageAt: Date | null;
  idleDays: number;
  rssMb: number | null;
  contextTokens: number | null;
  tier: CleanupTier;
  /** Machine-readable cause, stored on the row as trashReason when tier==='trash'. */
  reason: CleanupReason;
  /** Why it was spared, when tier==='keep'. Null otherwise. */
  blockedBy: string | null;
}

export type CleanupReason =
  | 'dispatch-done'
  | 'stillborn'
  | 'empty'
  | 'agent-trashed'
  | 'idle'
  | 'manual'
  | 'blocked';

// Human-facing text for the review sheet. Kept next to the reasons so a new
// reason can't ship without one.
export const REASON_LABEL: Record<CleanupReason, string> = {
  'dispatch-done': 'finished dispatch — its result was already reported back',
  stillborn: 'never got a reply — a failed spawn, not a conversation',
  empty: 'no messages at all',
  'agent-trashed': 'its agent is in the trash',
  idle: 'untouched for a long time',
  manual: 'cleaned by hand',
  blocked: 'something still points at it',
};

export const BLOCKER_LABEL: Record<string, string> = {
  cron: 'a cron reports into it',
  unread: 'its last message is unread',
  interaction: 'waiting on an answer from you',
  queued: 'has an undelivered message',
  unanswered: 'flagged: you asked, nobody answered',
  working: 'working right now',
  dispatch: 'wired to a Brain dispatch or takeover',
  grouped: 'filed in a group',
  named: 'you gave it a name — archived, but never auto-deleted',
  kept: 'you marked it Keep',
};

const DAY_MS = 86_400_000;

const daysSince = (d: Date, nowMs: number) => (nowMs - d.getTime()) / DAY_MS;

export interface CleanupOptions {
  archiveIdleDays?: number;
  trashIdleDays?: number;
  /** Restrict to one agent (a scoped share key can only ever clean its own). */
  agentName?: string | null;
  /** Only consider these ids — used when applying a human-edited review list. */
  onlyIds?: string[];
}

/**
 * Examine every live session on a machine and return one verdict each.
 *
 * Returns verdicts for candidates only (tier !== 'keep' or an explicit blocker),
 * newest-idle first, so the caller can render "45 of these, here's why" without
 * a second pass. Already-trashed sessions are out of scope entirely — they are
 * the purge pipeline's business.
 */
export async function computeCleanup(machineId: string, opts: CleanupOptions = {}): Promise<CleanupVerdict[]> {
  const archiveDays = opts.archiveIdleDays ?? DEFAULT_ARCHIVE_IDLE_DAYS;
  const trashDays = opts.trashIdleDays ?? DEFAULT_TRASH_IDLE_DAYS;
  const now = Date.now();

  const sessions = await prisma.chatSession.findMany({
    where: {
      machineId,
      trashedAt: null,
      ...(opts.agentName ? { agentName: opts.agentName } : {}),
      ...(opts.onlyIds ? { id: { in: opts.onlyIds } } : {}),
    },
    select: {
      id: true, agentName: true, title: true, titleAuto: true, preview: true, origin: true,
      startedAt: true, lastMessageAt: true, lastReadAt: true, closedAt: true, groupId: true,
      state: true, alive: true, rssMb: true, contextTokens: true, keepAt: true,
      unansweredMsgId: true, dispatchedBySessionId: true, takeoverBySessionId: true,
    },
  });
  if (sessions.length === 0) return [];

  const ids = sessions.map((s) => s.id);

  // Every inbound reference, resolved in four set-shaped queries rather than
  // per-session lookups — this runs behind a button, and 125 sessions × 4
  // round-trips is the difference between instant and a spinner.
  const [cronTargets, pendingInteractions, queuedMessages, sessionsWithAssistant, trashedAgents, dispatchParents] =
    await Promise.all([
      prisma.cron.findMany({
        where: { machineId, reportSessionId: { in: ids } },
        select: { reportSessionId: true },
      }),
      prisma.interaction.findMany({
        where: { sessionId: { in: ids }, status: 'pending' },
        select: { sessionId: true }, distinct: ['sessionId'],
      }),
      prisma.chatMessage.findMany({
        where: { sessionId: { in: ids }, ...USER_QUEUE_FILTER },
        select: { sessionId: true }, distinct: ['sessionId'],
      }),
      prisma.chatMessage.findMany({
        where: { sessionId: { in: ids }, role: 'assistant' },
        select: { sessionId: true }, distinct: ['sessionId'],
      }),
      prisma.agent.findMany({
        where: { machineId, trashedAt: { not: null } },
        select: { name: true },
      }),
      // Sessions that are the POKE TARGET of a live dispatch/takeover: deleting one
      // strands the watcher that would have reported back into it.
      //
      // `closedAt: null` on the CHILD is what makes this "live". Without it, a Brain
      // session would be pinned forever by a dispatch it finished months ago — and
      // "this agent once delegated something" is not evidence that its conversation
      // is still worth keeping.
      prisma.chatSession.findMany({
        where: {
          machineId,
          closedAt: null,
          trashedAt: null,
          OR: [{ dispatchedBySessionId: { in: ids } }, { takeoverBySessionId: { in: ids } }],
        },
        select: { dispatchedBySessionId: true, takeoverBySessionId: true },
      }),
    ]);

  const refs: SessionRefs = {
    hasCron: new Set(cronTargets.map((c) => c.reportSessionId).filter(Boolean) as string[]),
    hasInteraction: new Set(pendingInteractions.map((i) => i.sessionId)),
    hasQueued: new Set(queuedMessages.map((m) => m.sessionId)),
    hasAssistant: new Set(sessionsWithAssistant.map((m) => m.sessionId)),
    trashedAgentNames: new Set(trashedAgents.map((a) => a.name)),
    isPokeTarget: new Set<string>(),
    // Which sessions have ANY message at all — separates "opened by a mis-click"
    // from "asked something that never got answered".
    anyMessage: new Set(
      (await prisma.chatMessage.findMany({ where: { sessionId: { in: ids } }, select: { sessionId: true }, distinct: ['sessionId'] }))
        .map((m) => m.sessionId),
    ),
  };
  for (const d of dispatchParents) {
    if (d.dispatchedBySessionId) refs.isPokeTarget.add(d.dispatchedBySessionId);
    if (d.takeoverBySessionId) refs.isPokeTarget.add(d.takeoverBySessionId);
  }

  const out: CleanupVerdict[] = [];
  for (const s of sessions) {
    const v = classifySession(s, refs, { archiveDays, trashDays }, now);
    if (v) out.push(v);
  }
  out.sort((a, b) => b.idleDays - a.idleDays);
  return out;
}

/** The inbound references + message facts a verdict needs, resolved in bulk. */
export interface SessionRefs {
  hasCron: Set<string>;
  hasInteraction: Set<string>;
  hasQueued: Set<string>;
  hasAssistant: Set<string>;
  trashedAgentNames: Set<string>;
  isPokeTarget: Set<string>;
  anyMessage: Set<string>;
}

/** The session columns a verdict reads. Structural, so tests can build one by hand. */
export interface SessionFacts {
  id: string;
  agentName: string;
  title: string | null;
  titleAuto: boolean;
  preview: string | null;
  origin: string | null;
  startedAt: Date;
  lastMessageAt: Date | null;
  lastReadAt: Date | null;
  closedAt: Date | null;
  groupId: string | null;
  state: string | null;
  alive: boolean;
  rssMb: number | null;
  contextTokens: number | null;
  keepAt: Date | null;
  unansweredMsgId: string | null;
  dispatchedBySessionId: string | null;
  takeoverBySessionId: string | null;
}

/**
 * One session's verdict. Pure — every input is an argument, so the guardrails can
 * be tested directly, which matters more here than anywhere else in the feature:
 * a blocker that silently stops matching doesn't throw, it just quietly starts
 * proposing conversations that something still depends on.
 *
 * Returns null for a session not worth surfacing at all.
 */
export function classifySession(
  s: SessionFacts,
  refs: SessionRefs,
  thresholds: { archiveDays: number; trashDays: number },
  nowMs: number,
): CleanupVerdict | null {
  const idleDays = (nowMs - (s.lastMessageAt ?? s.startedAt).getTime()) / DAY_MS;
  const base = {
    id: s.id, agentName: s.agentName, title: s.title, preview: s.preview,
    lastMessageAt: s.lastMessageAt, idleDays, rssMb: s.rssMb, contextTokens: s.contextTokens,
  };

  // ── Blockers, in two strengths. ──
  //
  // The table below was written for the DESTRUCTIVE rung and was then applied
  // wholesale to the reversible one, which is why nothing was getting archived:
  // 32 sessions idle 3–60 days sat in the sidebar solely because the human had
  // typed a name for them.
  //
  // "I named this" is a strong statement about DELETING it and a weak one about
  // keeping it in the sidebar for two months. Archiving is reversible in a click
  // and the chat is still one toggle away, so a name no longer prevents it — it
  // only prevents the bin. Everything else here means "someone is still waiting
  // on this" or "the human filed this deliberately", and both still block outright.
  //
  // Ordered most-specific first so the reason shown is the interesting one:
  // "a cron reports here" is worth reading, "not old enough" is not.
  const unread = s.lastMessageAt != null && (s.lastReadAt == null || s.lastMessageAt > s.lastReadAt);
  const blocker =
    s.keepAt ? 'kept'
    : refs.hasCron.has(s.id) ? 'cron'
    : refs.hasInteraction.has(s.id) ? 'interaction'
    : refs.hasQueued.has(s.id) ? 'queued'
    : s.unansweredMsgId ? 'unanswered'
    : unread ? 'unread'
    : s.state === 'working' ? 'working'
    // A dispatch pins its session only while it is IN FLIGHT. `dispatchedBySessionId`
    // is set on every dispatch child for the lifetime of the row — it is how the
    // watcher knows whom to poke — so treating it as a blocker on its own would
    // shadow the `dispatch-done` rule below entirely and silently delete the single
    // most valuable disposable category. `closedAt` is the finish line: the watcher
    // has reported, the Brain has moved on, nothing is owed.
    // A takeover is different: `takeoverBySessionId` is CLEARED when the takeover
    // ends (endTakeover), so a non-null value always means live.
    : ((!s.closedAt && s.dispatchedBySessionId) || s.takeoverBySessionId || refs.isPokeTarget.has(s.id)) ? 'dispatch'
    // A group is the human's own filing, and a grouped session has already left
    // the flat recents for its drawer — archiving it would take it out of the
    // place they filed it, for no decluttering gain.
    : s.groupId ? 'grouped'
    : null;

  if (blocker) {
    // Only surface a spared session if it would otherwise have been touched —
    // otherwise the review sheet fills with hundreds of "not old enough" rows.
    return idleDays >= thresholds.archiveDays
      ? { ...base, tier: 'keep', reason: 'blocked', blockedBy: blocker }
      : null;
  }

  // Soft blocker: enough to keep a conversation out of the bin, not enough to keep
  // it in the sidebar forever.
  //
  // "The human named it" is inferred from titleAuto=false, and that inference has a
  // false positive: the column DEFAULTS to false, and `chat.createSession` accepts a
  // `title` without ever stamping it — so every session a machine opened with a
  // title (Brain dispatch's "Brain → agent", takeover, cron, cron-report) would read
  // as deliberate human organisation. `origin` is the discriminator: non-null exactly
  // when something other than a person opened the session. Only `chat.setTitle` —
  // the rename dialog — means a human typed it, and that path leaves origin null.
  const named = Boolean(s.title) && !s.titleAuto && !s.origin;

  // ── Disposable by construction, regardless of age. ──
  // A Brain dispatch is a one-shot delegation whose result was already reported
  // back to the dispatcher; its context is redundant BY DEFINITION, which makes
  // it the one case where "you can just start a new conversation" is provably
  // true rather than a judgement call. Still requires the session to be finished.
  if (!named && s.origin === 'dispatch' && s.closedAt && idleDays >= 1) {
    return { ...base, tier: 'trash', reason: 'dispatch-done', blockedBy: null };
  }
  if (!named && !refs.anyMessage.has(s.id) && idleDays >= 1) {
    return { ...base, tier: 'trash', reason: 'empty', blockedBy: null };
  }
  // Opened, spoken to, never answered — a failed spawn, not a conversation.
  if (!named && !refs.hasAssistant.has(s.id) && idleDays >= 1) {
    return { ...base, tier: 'trash', reason: 'stillborn', blockedBy: null };
  }
  if (!named && refs.trashedAgentNames.has(s.agentName)) {
    return { ...base, tier: 'trash', reason: 'agent-trashed', blockedBy: null };
  }

  // ── Age-driven rungs. ──
  // A named conversation is archived like any other, but never proposed for
  // deletion: past the bin threshold it surfaces as spared, with the reason.
  // Archived, and still untouched a month AFTER that.
  //
  // Both clocks matter, and the second one is the whole point of the rung. The
  // original rule was `idle >= 30d AND closedAt`, which looks equivalent and is
  // not: once a sweep archives a session that has ALREADY been quiet for 50 days,
  // it satisfies both halves the same minute, and the bin proposal adds no
  // evidence the archive step didn't already have. The ladder collapses into one
  // rung — everything old goes straight to "propose for deletion".
  //
  // That was invisible while archiving was rare and manual. It stops being
  // invisible the moment something archives on a schedule (the Brain's dream, or
  // cleanupIdleDays), which is exactly when it would have mattered most.
  //
  // So the bin asks for something archiving cannot supply: a month of you not
  // reopening it. `closedAt` is when it was archived; reopening clears it.
  if (idleDays >= thresholds.trashDays && s.closedAt && daysSince(s.closedAt, nowMs) >= thresholds.trashDays) {
    return named
      ? { ...base, tier: 'keep', reason: 'blocked', blockedBy: 'named' }
      : { ...base, tier: 'trash', reason: 'idle', blockedBy: null };
  }
  // Archive = out of the sidebar AND asleep. One action, because they are one
  // intent; see CleanupTier.
  if (idleDays >= thresholds.archiveDays && !s.closedAt) {
    return { ...base, tier: 'archive', reason: 'idle', blockedBy: null };
  }
  return null;
}
