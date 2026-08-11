// Direct dashboard ↔ agent chat. Sessions live in DB; gateway tails
// `pendingMessages` (user rows without deliveredAt) every couple seconds,
// hands them to the Anthropic SDK, then POSTs assistant rows back via
// /api/sync/chat-message. Browser tails messages via tRPC refetch (1s).

import { z } from 'zod';
import { router, gatewayProcedure, machineProcedure, agentProcedure } from '../trpc';
import { prisma } from '../db';
import { QUEUE_LIMIT } from '../../lib/chat-queue';
import { sessionRecencyMs } from '../../lib/session-recency';
import { stripNulDeep } from '../sanitize';
import { capMessageContent } from '../message-cap';
import { extractSearchText, extractInteractionBlocks } from '../chat-text';
import { generateSessionTitle } from '../session-title';
import {
  TAKEOVER_CONCURRENCY,
  endNote,
  startNote,
  type TakeoverEndReason,
} from '../../lib/takeover';
import { HUMAN_MESSAGES_MAX, humanMessages } from '../user-profile';
import { resolveRuntime } from '../runtime-resolve';
import { planRuntimeSwitch } from '../runtime-switch';
import {
  LIVE_SESSION,
  computeCleanup,
  DEFAULT_ARCHIVE_IDLE_DAYS,
  DEFAULT_TRASH_IDLE_DAYS,
  MAX_PER_RUN,
  type CleanupReason,
} from '../session-cleanup';

const ContentBlock = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.any(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.any(),
    is_error: z.boolean().optional(),
  }),
  z.object({ type: z.literal('thinking'), thinking: z.string().optional() }),
  z.object({ type: z.string(), [Symbol.for('passthrough')]: z.any() }).passthrough(),
]);

// What counts as a QUEUE message: one the USER composed in the dashboard composer
// (the `send` mutation), not yet picked up by the gateway. The decisive field is
// externalId === null — `send` never sets externalId, whereas every row the
// gateway syncs FROM the claude transcript carries one (the JSONL uuid). Those
// transcript rows are ALSO role:'user' + deliveredAt:null (a tool_result, or an
// image the agent Read mid-task, is role 'user' in Anthropic's format), so
// without the externalId:null guard the queue, the cap, clearQueue, and the
// gateway's pollPending would all scoop up the agent's OWN attachments. Shared by
// all four so they can never drift apart.
const USER_QUEUE_FILTER = { role: 'user', deliveredAt: null, externalId: null } as const;

// Growth ceiling on the recents payload (S4): without a bound listSessions returns
// every session ever, unbounded, polled every 5s on every page. 200 is well above
// the current per-machine count (~90) so it never truncates today — it just caps
// future growth to what the sidebar / agent-detail recents actually show.
const SESSION_LIST_CAP = 200;

/**
 * Archive the sessions a sweep picked: out of the sidebar AND asleep.
 *
 * Hibernation is a REQUEST, not an act — the gateway's hibernate tick owns the
 * actual pane kill and re-checks `working` on the live pane before it swings. So
 * an archive that races a turn starting can't cut it off.
 */
async function archiveSessions(machineId: string, verdicts: Array<{ id: string; tier: string }>): Promise<number> {
  const ids = verdicts.filter((v) => v.tier === 'archive').map((v) => v.id).slice(0, MAX_PER_RUN);
  if (ids.length === 0) return 0;
  const now = new Date();
  await prisma.chatSession.updateMany({
    where: { id: { in: ids }, machineId },
    data: { closedAt: now, hibernateRequestedAt: now },
  });
  return ids.length;
}

// Stamp what a cleanup run did onto the machine row. Merges rather than replaces,
// so the "trashed 8" from a review-sheet confirm doesn't erase the "archived 30"
// the same click's reversible pass just recorded a moment earlier — the two halves
// of one cleanup arrive as two writes and should read back as one run.
async function recordCleanupRun(
  machineId: string,
  delta: { archived?: number; trashed?: number; auto: boolean },
): Promise<void> {
  const m = await prisma.machine.findUnique({ where: { id: machineId }, select: { lastCleanupAt: true, lastCleanupSummary: true } });
  // Same run = same few seconds. Anything older starts a fresh summary rather than
  // accumulating forever into a number nobody can interpret.
  const SAME_RUN_MS = 60_000;
  const fresh = m?.lastCleanupAt != null && Date.now() - m.lastCleanupAt.getTime() < SAME_RUN_MS;
  const prev = (fresh ? (m?.lastCleanupSummary as Record<string, number> | null) : null) ?? {};
  await prisma.machine.update({
    where: { id: machineId },
    data: {
      lastCleanupAt: new Date(),
      lastCleanupSummary: {
        archived: (prev.archived ?? 0) + (delta.archived ?? 0),
        trashed: (prev.trashed ?? 0) + (delta.trashed ?? 0),
        auto: delta.auto,
      },
    },
  });
}

// Content cast used everywhere we write a message row: the column is opaque JSON,
// Prisma wants Prisma.InputJsonValue, and the block-shaped union confuses inference.
type MessageContent = Parameters<typeof prisma.chatMessage.create>[0]['data']['content'];
const asContent = (blocks: Array<Record<string, unknown>>) => blocks as unknown as MessageContent;

/**
 * Drop a machine-generated prompt into an agent's session — the mechanism behind
 * both watchers' `[dispatch update]` / `[takeover update]` pokes and the Brain's
 * own nudges. Returns false when the target session is gone or closed.
 *
 * `authoredBy: 'system'` matters more than it looks: these rows are role 'user',
 * and without the marker every poke the gateway ever generated would read as
 * something the human typed and land in the USER-PROFILE.md corpus (server/user-profile.ts).
 */
async function pokeSession(sessionId: string, machineId: string, text: string): Promise<boolean> {
  const target = await prisma.chatSession.findFirst({
    where: { id: sessionId, machineId, closedAt: null, ...LIVE_SESSION },
    select: { id: true },
  });
  if (!target) return false;
  await prisma.chatMessage.create({
    data: {
      sessionId: target.id,
      role: 'user',
      content: asContent([{ type: 'text', text }]),
      authoredBy: 'system',
    },
  });
  await prisma.chatSession.update({ where: { id: target.id }, data: { lastMessageAt: new Date() } });
  return true;
}

/**
 * End a takeover: clear the routing fields and leave a system row in the
 * conversation saying why. Idempotent — releasing an already-ended takeover is a
 * no-op, which matters because three different paths can end one (the Brain
 * releasing, a cap tripping, the human typing) and they can race.
 */
async function endTakeover(
  sessionId: string,
  reason: TakeoverEndReason,
  summary?: string | null,
): Promise<boolean> {
  const cleared = await prisma.chatSession.updateMany({
    where: { id: sessionId, takeoverBySessionId: { not: null } },
    data: {
      takeoverBySessionId: null,
      takeoverStartedAt: null,
      takeoverTurns: 0,
      takeoverGoal: null,
      takeoverNotify: null,
      takeoverDraft: null,
      takeoverDraftAt: null,
    },
  });
  if (cleared.count === 0) return false; // already ended by whoever got there first
  await prisma.chatMessage.create({
    data: {
      sessionId,
      role: 'system',
      content: asContent([{ type: 'text', text: endNote(reason, summary) }]),
    },
  });
  return true;
}

/** The machine's Brain agent, or null if none is set up. */
async function findBrainAgent(machineId: string) {
  return prisma.agent.findFirst({
    where: { machineId, isOrchestrator: true },
    select: { name: true },
  });
}

export const chatRouter = router({
  listSessions: agentProcedure
    // Tolerate a `null` input (some client paths serialize an omitted/undefined
    // arg as JSON null in the GET batch → zod's `.default({})` only fills
    // undefined, so null 400'd: 3 failed listSessions per page load + retries).
    // null/undefined both mean "no agent filter" → normalize to {}.
    .input(z.preprocess((v) => (v == null ? undefined : v), z.object({ agentName: z.string().optional() }).default({})))
    .query(async ({ ctx, input }) => {
      // A scoped share key can only ever see its own agent's sessions, no matter
      // what (or whether) agentName was passed.
      const agentName = ctx.scopedAgent ?? input.agentName;
      const where = {
        machineId: ctx.machine.id,
        ...(agentName ? { agentName } : {}),
        ...LIVE_SESSION,
      };
      const select = {
        id: true,
        agentName: true,
        title: true,
        origin: true,
        startedAt: true,
        lastMessageAt: true,
        lastReadAt: true,
        closedAt: true,
        hiddenAt: true,
        // Which sidebar drawer this session is filed in; null = it stays in the
        // flat recents list.
        groupId: true,
        restartRequestedAt: true,
        alive: true,
        state: true,
        contextTokens: true,
        runtime: true,
        runtimeProvider: true,
        runtimeModel: true,
        runtimeMode: true,
        snapshotAt: true,
        // loopState is deliberately NOT selected here (P1-2): it's the entire
        // .loop-state.json blob and measured at 38% of this 5s-polled payload
        // (21KB across the machine's sessions), yet the only client reader is
        // the *current* session's LoopBar, which now sources loopState from
        // chat.getSession (page.tsx). Don't re-add it to this list query.
        // Resource governance: per-session memory + hibernation state, read by
        // the sidebar rows (rss + 💤) and the Host-health panel.
        rssMb: true,
        hibernatedAt: true,
        // Dropped claudeSessionId / pid / outputTokens / lastActivity: no UI
        // consumer reads them, and this payload (~900B × every session) polls
        // every 5s on every page. The gateway still gets them via its own routes.
        // Sidebar preview is now a denormalized column (set by chat.send + a
        // one-time backfill) instead of a per-session first-user-message
        // subquery — that subquery (40 sessions × pulling each first message's
        // full content to slice 120 chars) was the ~0.5–0.9s listSessions cost.
        preview: true,
      } as const;

      // STRICTLY most-recent-first, by `sessionRecencyMs` — the same key the row
      // displays, which is the point of it. Getting that key right has failed twice:
      //
      //  1. An early order led with `closedAt: 'asc'`, which reads as "open ones
      //     first" and does the opposite — Postgres sorts ASC NULLS LAST, so every
      //     ARCHIVED session came before every open one and the sidebar's top was
      //     archived conversations.
      //  2. Then `lastMessageAt DESC NULLS LAST`, which fixed that but stranded the
      //     OTHER null: a session created and not yet spoken to has no lastMessageAt,
      //     so it sank below conversations from months ago while its own row read
      //     "1d ago" (the sidebar prints the startedAt fallback). Every brand-new
      //     chat appeared at the very bottom of the list.
      //
      // SQL has no such fallback in `orderBy`, so the key is applied in JS — and the
      // split into two capped queries is what keeps `take` honest. Capping a single
      // query can only cap by ONE of the columns, which on a machine past the cap
      // would drop never-messaged sessions from the list entirely rather than merely
      // misplace them. Capping each side separately cannot: the true freshest N is a
      // subset of (freshest N messaged ∪ freshest N unmessaged).
      //
      // Cost: the two run in parallel, so it stays one round trip, and the second one
      // is nearly free — (machineId, lastMessageAt) serves its NULL slice directly and
      // that slice is a handful of rows, since a session leaves it for good on its
      // first message. Measured on the fleet's busiest machine (89 live sessions):
      // 0.14ms for the null branch, 0.35ms for the messaged one.
      const [messaged, unmessaged] = await Promise.all([
        prisma.chatSession.findMany({
          where: { ...where, lastMessageAt: { not: null } },
          // startedAt breaks exact lastMessageAt ties, so the poll can't hand back
          // two orderings of the same data and shuffle rows under the cursor.
          orderBy: [{ lastMessageAt: 'desc' }, { startedAt: 'desc' }],
          take: SESSION_LIST_CAP,
          select,
        }),
        prisma.chatSession.findMany({
          where: { ...where, lastMessageAt: null },
          orderBy: { startedAt: 'desc' },
          take: SESSION_LIST_CAP,
          select,
        }),
      ]);
      const rows = [...messaged, ...unmessaged]
        .sort((a, b) => sessionRecencyMs(b) - sessionRecencyMs(a))
        .slice(0, SESSION_LIST_CAP);

      // Resolve each row's backend against its agent's default. The column holds
      // only the session's OWN choice, and null means "inherit" — returning it
      // raw made every inherited session read as the fleet default, so a pi
      // agent's sessions were all labelled Claude Code in the chat header.
      // One query for the machine's agents, not one per row.
      const agentRuntimes = await prisma.agent.findMany({
        where: { machineId: ctx.machine.id, name: { in: [...new Set(rows.map((r) => r.agentName))] } },
        select: { name: true, runtime: true, runtimeProvider: true, runtimeModel: true, runtimeMode: true },
      });
      const byName = new Map(agentRuntimes.map((a) => [a.name, a]));
      return rows.map((r) => ({ ...r, ...resolveRuntime(r, byName.get(r.agentName)) }));
    }),

  // Single-session meta for the chat HEADER (title / agentName / state / preview /
  // closedAt flags). Split out from listSessions so opening a session resolves the
  // header AND enables the composer from a fast single-row PK lookup, instead of
  // waiting on the whole list (40 sessions × a per-row preview subquery measured at
  // ~0.5–0.9s). The chat page uses this for early paint and falls back to the list.
  // Same row shape as a listSessions entry (incl. derived `preview`). Returns null
  // for unknown / cross-tenant ids (a scoped key only matches its own agent).
  getSession: agentProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findFirst({
        where: {
          id: input.sessionId,
          machineId: ctx.machine.id,
          ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}),
          ...LIVE_SESSION,
        },
        select: {
          id: true,
          agentName: true,
          title: true,
          origin: true,
          startedAt: true,
          lastMessageAt: true,
          lastReadAt: true,
          closedAt: true,
          hiddenAt: true,
          restartRequestedAt: true,
          alive: true,
          state: true,
          contextTokens: true,
          runtime: true,
          runtimeProvider: true,
          runtimeModel: true,
          runtimeMode: true,
          snapshotAt: true,
          loopState: true,
          rssMb: true,
          hibernatedAt: true,
          preview: true,
          // Takeover state — drives the chat banner (whether the Brain is driving,
          // what it thinks it's doing, and how much rope it has left).
          takeoverBySessionId: true,
          takeoverGoal: true,
          takeoverTurns: true,
          takeoverStartedAt: true,
          takeoverDraft: true,
        },
      });
      // Resolve the backend the same way pollPending does — a session's own
      // runtime may be null, meaning "inherit the agent's". The chat header
      // shows the answer, so it must be the resolved one, not the raw column.
      let backend: ReturnType<typeof resolveRuntime> | null = null;
      if (s) {
        const agent = await prisma.agent.findUnique({
          where: { machineId_name: { machineId: ctx.machine.id, name: s.agentName } },
          select: { runtime: true, runtimeProvider: true, runtimeModel: true, runtimeMode: true },
        });
        backend = resolveRuntime(s, agent);
      }

      // While a takeover is live, also report whether the BRAIN itself is mid-turn.
      // Between the agent finishing and the Brain's next move there's a minute of
      // nothing visible — it's reading and deciding — and with no signal for that the
      // feature looks stalled when it's working. One PK lookup, only when a takeover
      // is actually running.
      if (s?.takeoverBySessionId) {
        const brain = await prisma.chatSession.findUnique({
          where: { id: s.takeoverBySessionId },
          select: { state: true },
        });
        return { ...s, ...backend, takeoverBrainState: brain?.state ?? null };
      }
      return s ? { ...s, ...backend, takeoverBrainState: null } : s;
    }),

  // Everything the session detail sheet shows, and NOTHING the chat header
  // already polls. Deliberately a separate query from getSession: this one runs
  // only while the sheet is open, so it can afford the message count, the group
  // name and the agent's own defaults — three extra round trips that would
  // otherwise ride along on a 5s poll for every open chat.
  sessionDetail: agentProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findFirst({
        where: {
          id: input.sessionId,
          machineId: ctx.machine.id,
          ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}),
          ...LIVE_SESSION,
        },
        select: {
          id: true, agentName: true, title: true, titleAuto: true, origin: true,
          startedAt: true, lastMessageAt: true, lastReadAt: true, lastActivity: true,
          closedAt: true, hiddenAt: true, hibernatedAt: true, groupId: true,
          runtime: true, runtimeProvider: true, runtimeModel: true, runtimeMode: true,
          claudeSessionId: true, transcriptPath: true,
          pid: true, alive: true, state: true, rssMb: true,
          contextTokens: true, outputTokens: true, snapshotAt: true,
        },
      });
      if (!s) return null;

      const [agent, messageCount, group] = await Promise.all([
        prisma.agent.findUnique({
          where: { machineId_name: { machineId: ctx.machine.id, name: s.agentName } },
          select: {
            directory: true, runtime: true, runtimeProvider: true, runtimeModel: true, runtimeMode: true,
          },
        }),
        prisma.chatMessage.count({ where: { sessionId: s.id } }),
        s.groupId
          ? prisma.sessionGroup.findUnique({ where: { id: s.groupId }, select: { name: true } })
          : Promise.resolve(null),
      ]);

      return {
        ...s,
        messageCount,
        groupName: group?.name ?? null,
        agentDirectory: agent?.directory ?? null,
        // The answer the gateway acts on…
        backend: resolveRuntime(s, agent),
        // …and where it came from, so the sheet can say "inherited from the
        // agent" instead of presenting an inherited value as a session setting.
        inherited: s.runtime == null,
        agentBackend: resolveRuntime(null, agent),
      };
    }),

  // Move this session to another backend.
  //
  // Always writes the session's OWN columns rather than clearing them back to
  // "inherit": having explicitly chosen a backend for THIS conversation, the
  // user should not have it change under them the next time the agent's default
  // is edited.
  //
  // Context does not travel. Each backend keeps its own history (claude's
  // transcript, pi's session file) and the dashboard keeps the full message
  // list either way — but the new backend starts the next turn without the old
  // one's context. The UI says so before it fires.
  setSessionRuntime: agentProcedure
    .input(
      z.object({
        id: z.string(),
        runtime: z.enum(['claude-tmux', 'pi-rpc']),
        runtimeProvider: z.string().max(64).nullish(),
        runtimeModel: z.string().max(128).nullish(),
        runtimeMode: z.string().max(64).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);

      const agent = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: s.agentName } },
        select: { runtime: true, runtimeProvider: true, runtimeModel: true, runtimeMode: true },
      });
      const before = resolveRuntime(s, agent);
      const after = resolveRuntime(
        {
          runtime: input.runtime,
          runtimeProvider: input.runtimeProvider ?? null,
          runtimeModel: input.runtimeModel ?? null,
          // Omitted means "leave the mode alone", not "reset to default" — the
          // session sheet omits it when switching to claude (which has no
          // modes), and having that silently knock an ops session back to
          // coding on the way back to pi would be a trap.
          runtimeMode: input.runtimeMode === undefined ? s.runtimeMode : input.runtimeMode,
        },
        agent,
      );

      const plan = planRuntimeSwitch(s, before, after);
      if (!plan.ok) throw new Error(plan.reason);

      await prisma.chatSession.update({
        where: { id: input.id },
        data: {
          runtime: input.runtime,
          runtimeProvider: input.runtimeProvider ?? null,
          runtimeModel: input.runtimeModel ?? null,
          ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
          // Free the outgoing backend's process. Hibernate is exactly the right
          // lever: it tears down whatever is running and leaves the session
          // "asleep, wakes on send" — which is what a just-switched session is.
          // The gateway's hibernate tick stops a pi child and kills a tmux pane,
          // and each is a no-op for a session that never had one, so it does not
          // need to know which direction the switch went.
          ...(plan.restart ? { hibernateRequestedAt: new Date() } : {}),
        },
      });

      return { ok: true, restarted: plan.restart, backend: after };
    }),

  // Mark a session read = now. Was browser localStorage (per-device); now a DB
  // stamp so the red "unread" dot clears on every device (the chat pane fires
  // this on open + on each new message while open; other devices reconcile on
  // their next listSessions poll). Idempotent; silently no-ops for other
  // machines' sessions so a stale tab can't 500.
  markRead: agentProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const res = await prisma.chatSession.updateMany({
        where: { id: input.sessionId, machineId: ctx.machine.id, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
        data: { lastReadAt: new Date() },
      });
      return { ok: res.count > 0 };
    }),

  // Hide / unhide a session from the sidebar recents list. Purely a UI filter —
  // the session keeps running; a "show hidden" toggle in the sidebar reveals it.
  // updateMany + machineId guard (like markRead) so a stale tab can't 500 / touch
  // another machine's session.
  setHidden: agentProcedure
    .input(z.object({ id: z.string(), hidden: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const res = await prisma.chatSession.updateMany({
        where: { id: input.id, machineId: ctx.machine.id, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
        data: { hiddenAt: input.hidden ? new Date() : null },
      });
      return { ok: res.count > 0 };
    }),

  createSession: agentProcedure
    .input(
      z.object({
        agentName: z.string().min(1).max(64),
        title: z.string().max(120).optional(),
        origin: z.string().max(32).optional(),
        // Brain dispatch routing: the Brain chat session that opened this dispatch,
        // so the gateway dispatch-watcher knows whom to poke on finish/block.
        dispatchedBySessionId: z.string().max(64).optional(),
        // Which backend runs this session. Omitted = inherit the agent's
        // default, which is what every caller that predates the picker does.
        runtime: z.enum(['claude-tmux', 'pi-rpc']).optional(),
        runtimeProvider: z.string().max(64).optional(),
        runtimeModel: z.string().max(128).optional(),
        // Which pi mode to spawn under. Omitted = inherit the agent's, then the
        // fleet default. Not validated against the installed modes here: the
        // dashboard has no view of what is on the machine's disk, so an unknown
        // name is the gateway's to fall back from (see resolveMode).
        runtimeMode: z.string().max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return prisma.chatSession.create({
        data: {
          machineId: ctx.machine.id,
          agentName: input.agentName,
          title: input.title ?? null,
          origin: input.origin ?? null,
          dispatchedBySessionId: input.dispatchedBySessionId ?? null,
          runtime: input.runtime ?? null,
          runtimeProvider: input.runtimeProvider ?? null,
          runtimeModel: input.runtimeModel ?? null,
          runtimeMode: input.runtimeMode ?? null,
        },
      });
    }),

  // Point an existing dispatch session at the Brain session that (re)used it, so
  // the dispatch-watcher pokes the CURRENT dispatcher — not whoever opened it
  // first. Used by the `dispatch` MCP tool on the reuse path.
  setDispatchOrigin: agentProcedure
    .input(z.object({ id: z.string(), dispatchedBySessionId: z.string().max(64).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      return prisma.chatSession.update({
        where: { id: input.id },
        data: { dispatchedBySessionId: input.dispatchedBySessionId },
      });
    }),

  closeSession: agentProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      return prisma.chatSession.update({ where: { id: input.id }, data: { closedAt: new Date() } });
    }),

  reopenSession: agentProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      return prisma.chatSession.update({ where: { id: input.id }, data: { closedAt: null } });
    }),

  // Hard delete a session + its messages (ChatMessage cascades on the FK).
  //
  // This orphans the session's tmux pane, and that is NOT harmless: every
  // pane-killing path (hibernate tick, reaper, reattach loop) is driven by a DB
  // row, so a pane with no row is unreachable by all of them — it holds its
  // ~100-500MB claude until the host reboots. (An older comment here claimed the
  // next gateway restart reclaimed it. It does not; there is no startup sweep.)
  //
  // Two things now cover that: the gateway's orphan-pane sweep
  // (gateway/src/orphan-pane-reaper.ts) kills such panes within ~10 min, and
  // `trashSessions` — the path cleanup and the UI use — hibernates FIRST and only
  // purges once the pane is confirmed gone. Prefer that path; this stays as the
  // immediate, unconditional delete for a single session the user asked to remove.
  deleteSession: agentProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      await prisma.chatSession.delete({ where: { id: input.id } });
      return { ok: true };
    }),

  // Append a synthetic system message to a session. Used by the composer to
  // unstick the UI right after a built-in slash command (`/status` etc.) is
  // sent: most slash commands print to claude's TUI panel but produce NO
  // JSONL turn, so without a follow-up the dashboard sits forever on
  // "assistant is working…" (isWaitingAssistant is driven by lastMsg.role ===
  // 'user'). A short "↳ sent /X" note flips lastMsg.role to 'system' and
  // clears the in-flight state.
  appendSystemNote: agentProcedure
    .input(z.object({ sessionId: z.string(), text: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      const content = [{ type: 'text', text: input.text }];
      return prisma.chatMessage.create({
        data: {
          sessionId: input.sessionId,
          role: 'system',
          content: content as unknown as Parameters<typeof prisma.chatMessage.create>[0]['data']['content'],
        },
      });
    }),

  setTitle: agentProcedure
    .input(z.object({ id: z.string(), title: z.string().max(120) }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      // A human named it → mark it theirs, so the auto-titler leaves it alone
      // from here on (see server/session-title.ts). An empty string clears the
      // name and hands the session back to the auto-titler.
      const named = input.title.trim();
      return prisma.chatSession.update({
        where: { id: input.id },
        data: named ? { title: named, titleAuto: false } : { title: null, titleAuto: false, titleUserMsgCount: null },
      });
    }),

  // Summarize the opening exchange into a session title. Idempotent by default:
  // a session that already has a title returns it untouched, so the client can
  // fire this on every open without guarding. `force` is the manual regenerate.
  // See server/session-title.ts.
  autoTitle: agentProcedure
    .input(z.object({ sessionId: z.string(), force: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      return generateSessionTitle(input.sessionId, ctx.machine.id, {
        force: input.force,
        scopedAgent: ctx.scopedAgent,
      });
    }),

  listMessages: agentProcedure
    .input(z.object({ sessionId: z.string(), limit: z.number().int().min(1).max(1000).default(300) }))
    .query(async ({ ctx, input }) => {
      // Owner check folded into the WHERE clause — drops the extra
      // chatSession.findUnique round trip. Returns [] for unknown or
      // cross-tenant sessions (vs throwing) — chat UI tolerates that. A scoped
      // share key additionally only matches its own agent's session.
      //
      // Fetch the NEWEST `limit` rows, not the oldest. `take` with an ascending
      // order returns the FIRST N (oldest), so a session past `limit` messages
      // would freeze on its opening N and never surface new turns — the cap
      // reads as "the agent stopped replying". Order desc + reverse gives the
      // newest window in ascending (oldest→newest) order for the timeline.
      // `id` is the tiebreaker so rows sharing a `createdAt` (batch inserts
      // collide at ms resolution) stay deterministically ordered — and match
      // the SSE stream's ordering so the client's merge-by-id aligns.
      const rows = await prisma.chatMessage.findMany({
        where: {
          sessionId: input.sessionId,
          session: { machineId: ctx.machine.id, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
        // Only the columns the timeline actually reads (`CachedMsg` in
        // chat/page.tsx) + matches the SSE stream's shape so merge-by-id aligns.
        // Skips deliveredAt/externalId/updatedAt/sessionId — pure per-row overhead
        // multiplied across the window. `authoredBy` IS carried: the timeline has to
        // render a Brain-spoken turn differently from one the human typed, and it's
        // a mostly-null short string.
        select: { id: true, role: true, content: true, createdAt: true, authoredBy: true },
      });
      return rows.reverse().map((r) => ({ ...r, content: capMessageContent(r.content) }));
    }),

  // ─── Local cache sync (browser IndexedDB) ─────────────────────────────────
  // The browser keeps every session's PROSE (text blocks only, ~11 MB for the
  // whole machine) so search covers all history instead of the loaded window.
  // Three endpoints back it: a probe that says what changed, a delta fetch, and
  // a window fetch for jumping to a hit outside the newest-N window.

  // "What changed?" — one row per session that has messages: its watermark
  // (MAX(updatedAt)) and row count, plus the metadata the search UI shows next
  // to a hit. The client diffs this against what it has cached.
  //
  // The watermark is MAX(updatedAt), NOT ChatSession.lastMessageAt. lastMessageAt
  // is deliberately NOT bumped for upsert-UPDATES (api/sync/chat-message keeps it
  // still so a gateway reload doesn't flip every session to unread) — but the
  // gateway rewrites the assistant row in place as a turn streams, so a
  // lastMessageAt-based watermark would miss the entire live turn. updatedAt is
  // @updatedAt, so it moves on insert AND in-place update; it's the same signal
  // /api/chat/stream already polls.
  //
  // `count` catches the one thing a watermark can't: a DELETED row leaves the
  // watermark untouched. Only undelivered queue rows can be deleted (dequeue /
  // clearQueue) — history is append-only — but those carry user prose, so a
  // count mismatch triggers a full resync of that session.
  //
  // Cost: the groupBy is an index-only scan on @@index([sessionId, updatedAt]) —
  // measured 27 ms for 193k messages across 158 sessions, cheap enough to poll.
  syncProbe: agentProcedure.query(async ({ ctx }) => {
    const scope = { machineId: ctx.machine.id, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) };
    const [sessions, groups] = await Promise.all([
      prisma.chatSession.findMany({
        where: scope,
        select: { id: true, agentName: true, title: true, preview: true },
      }),
      prisma.chatMessage.groupBy({
        by: ['sessionId'],
        where: { session: scope },
        _max: { updatedAt: true },
        _count: { _all: true },
      }),
    ]);
    const meta = new Map(sessions.map((s) => [s.id, s]));
    const out: Array<{
      sessionId: string;
      agentName: string;
      title: string | null;
      preview: string | null;
      watermark: number;
      count: number;
    }> = [];
    for (const g of groups) {
      const m = meta.get(g.sessionId);
      if (!m) continue; // session vanished between the two queries
      out.push({
        sessionId: g.sessionId,
        agentName: m.agentName,
        title: m.title,
        preview: m.preview,
        watermark: g._max.updatedAt?.getTime() ?? 0,
        count: g._count._all,
      });
    }
    return out;
  }),

  // Delta fetch: the session's messages whose updatedAt is past the client's
  // watermark, as PROSE ONLY (extractSearchText → text blocks). ~1.2% of the
  // content column's bytes; see server/chat-text.ts.
  //
  // The cursor is (updatedAt, id), not updatedAt alone: batch inserts collide at
  // millisecond resolution, so a bare `updatedAt > since` would re-fetch the tied
  // rows forever (or, with `>=`, never advance) once more than `limit` rows share
  // one millisecond. Rows with no prose at all (pure tool_result / thinking turns)
  // are dropped here rather than stored empty — but they still MOVE the cursor,
  // so the client's next `since` comes from the batch's last SCANNED row.
  syncText: agentProcedure
    .input(
      z.object({
        sessionId: z.string(),
        since: z.number().int().nonnegative().default(0),
        afterId: z.string().optional(),
        limit: z.number().int().min(1).max(2000).default(1000),
      })
    )
    .query(async ({ ctx, input }) => {
      const sinceDate = new Date(input.since);
      const rows = await prisma.chatMessage.findMany({
        where: {
          sessionId: input.sessionId,
          session: { machineId: ctx.machine.id, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
          ...(input.since > 0
            ? {
                OR: [
                  { updatedAt: { gt: sinceDate } },
                  ...(input.afterId ? [{ updatedAt: sinceDate, id: { gt: input.afterId } }] : []),
                ],
              }
            : {}),
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: input.limit,
        select: { id: true, role: true, content: true, createdAt: true, updatedAt: true, authoredBy: true },
      });
      const last = rows[rows.length - 1];
      // Primitives only — no Date in the payload. The sync engine talks to this
      // endpoint over plain fetch (it runs outside React, so it has no tRPC
      // client), and superjson's Date envelope would have to be decoded by hand.
      // ISO strings are what the cache stores anyway.
      return {
        rows: rows
          .map((r) => {
            const blocks = extractInteractionBlocks(r.content);
            return {
              id: r.id,
              sessionId: input.sessionId,
              role: r.role,
              createdAt: r.createdAt.toISOString(),
              text: extractSearchText(r.content),
              // Only present when there is something to carry, so the payload
              // for the 99% prose case is byte-identical to before.
              ...(blocks.length > 0 ? { blocks } : {}),
              // Same reasoning: absent for the human-typed majority, so existing
              // cached rows stay valid and only Brain/system rows grow a field.
              ...(r.authoredBy ? { authoredBy: r.authoredBy } : {}),
            };
          })
          // A row earns its place by being readable: prose, or a card the user
          // was shown. Interaction cards have no prose and used to be dropped.
          .filter((r) => r.text.length > 0 || r.blocks),
        // Cursor from the last SCANNED row (pre-filter) so prose-less rows can't
        // stall the sync, and `done` from the scanned count for the same reason.
        cursor: last ? { since: last.updatedAt.getTime(), afterId: last.id } : null,
        done: rows.length < input.limit,
      };
    }),

  // One page of history OLDER than a known message — what "load earlier" runs on.
  //
  // The timeline used to page by GROWING listMessages' window: 60 → 260 → 460.
  // Every click re-fetched everything already on screen, so the third click cost
  // more than the first two combined (measured: +404 KB, +634 KB, +898 KB for
  // three clicks — 1.9 MB to read back 600 messages). Worse, the SSE stream is
  // keyed on the same window, so after a few clicks every 250 ms tick re-sent
  // hundreds of rows.
  //
  // Fetching only the older slice makes each click a flat ~200 rows, and lets
  // the live window stay pinned at its initial size.
  listMessagesBefore: agentProcedure
    .input(
      z.object({
        sessionId: z.string(),
        beforeId: z.string(),
        limit: z.number().int().min(1).max(500).default(200),
      })
    )
    .query(async ({ ctx, input }) => {
      const scope = {
        sessionId: input.sessionId,
        session: { machineId: ctx.machine.id, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
      };
      const anchor = await prisma.chatMessage.findFirst({
        where: { ...scope, id: input.beforeId },
        select: { id: true, createdAt: true },
      });
      if (!anchor) return { rows: [], hasMore: false };
      // (createdAt, id) ordering matches listMessages, so the prepended page
      // butts directly against the window with no gap and no overlap.
      const rows = await prisma.chatMessage.findMany({
        where: {
          ...scope,
          OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1, // one extra row answers hasMore without a COUNT
        select: { id: true, role: true, content: true, createdAt: true, authoredBy: true },
      });
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      return {
        rows: page.reverse().map((r) => ({ ...r, content: capMessageContent(r.content) })),
        hasMore,
      };
    }),

  // The window AROUND a specific message — how a search hit outside the newest-N
  // window gets opened. listMessages only ever walks back from the newest row, so
  // without this a hit 20,000 messages deep would need 100 "load earlier" clicks.
  // Returns the same shape (and the same capMessageContent treatment) as
  // listMessages so the timeline can render it interchangeably.
  listMessagesAround: agentProcedure
    .input(
      z.object({
        sessionId: z.string(),
        messageId: z.string(),
        before: z.number().int().min(0).max(200).default(40),
        after: z.number().int().min(0).max(200).default(40),
      })
    )
    .query(async ({ ctx, input }) => {
      const scope = {
        sessionId: input.sessionId,
        session: { machineId: ctx.machine.id, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
      };
      const anchor = await prisma.chatMessage.findFirst({
        where: { ...scope, id: input.messageId },
        select: { id: true, createdAt: true },
      });
      if (!anchor) return { rows: [], hasBefore: false, hasAfter: false };
      // Ordering matches listMessages: (createdAt, id). "Before" walks back from
      // the anchor in desc order then flips; "after" reads forward. The anchor
      // itself comes from the `after` side so it's never duplicated.
      const [before, after] = await Promise.all([
        prisma.chatMessage.findMany({
          where: {
            ...scope,
            OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.before,
          select: { id: true, role: true, content: true, createdAt: true, authoredBy: true },
        }),
        prisma.chatMessage.findMany({
          where: {
            ...scope,
            OR: [{ createdAt: { gt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { gte: anchor.id } }],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: input.after + 1, // +1 for the anchor row itself
          select: { id: true, role: true, content: true, createdAt: true, authoredBy: true },
        }),
      ]);
      const rows = [...before.reverse(), ...after].map((r) => ({ ...r, content: capMessageContent(r.content) }));
      return {
        rows,
        hasBefore: before.length === input.before,
        hasAfter: after.length === input.after + 1,
      };
    }),

  // The pending dispatch queue for a session: user messages the gateway hasn't
  // picked up yet (deliveredAt=null), oldest first. Small by construction (capped
  // at QUEUE_LIMIT by `send`). Kept SEPARATE from listMessages so that hot,
  // perf-tuned query keeps skipping deliveredAt. Drives the composer's QueueBar.
  queue: agentProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      return prisma.chatMessage.findMany({
        where: {
          sessionId: input.sessionId,
          session: { machineId: ctx.machine.id, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
          ...USER_QUEUE_FILTER,
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, content: true, createdAt: true },
      });
    }),

  // Per-round results for a loop. Each loop iteration posts its report to the chat
  // as an assistant message starting with "↻ loop `<id8>` · run N — …". Pull just
  // those via a SQL LIKE on the marker so it's NOT bounded by listMessages'
  // 300-row window — the loop card can show every round. id8 = first 8 chars (the
  // skill's marker uses the short id; a ≤8-char custom id matches itself). Newest
  // first.
  loopRuns: agentProcedure
    .input(
      z.object({
        sessionId: z.string(),
        loopId: z.string(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({
        where: { id: input.sessionId },
        select: { machineId: true, agentName: true },
      });
      if (!s || s.machineId !== ctx.machine.id) return [];
      ctx.assertAgent(s.agentName);
      // Require the marker INSIDE a "text" block — excludes the role:'assistant'
      // Bash tool_use messages that merely echo the marker into a file (which
      // would otherwise double the count). jsonb sorts keys, so a text block is
      // `{"text": "…", "type": "text"}` — match `"text": "` before the marker.
      const marker = `%"text": "%↻ loop \`${input.loopId.slice(0, 8)}\`%`;
      const rows = await prisma.$queryRaw<Array<{ id: string; content: unknown; createdAt: Date }>>`
        SELECT id, content, "createdAt"
        FROM "ChatMessage"
        WHERE "sessionId" = ${input.sessionId}
          AND role = 'assistant'
          AND content::text LIKE ${marker}
        ORDER BY "createdAt" DESC
        LIMIT ${input.limit}
      `;
      return rows;
    }),

  // Per-loop delete from the dashboard: queue an agent-request the gateway
  // applies (removes the loop from <agentDir>/.loop-state.json). The loop card is
  // driven by that file, so this makes a stopped loop disappear everywhere for
  // good — not just hide it locally. Only stopped loops are offered a delete in
  // the UI, and the gateway additionally refuses to remove a running one.
  // agentName is resolved from the session (the loop lives in that agent's file).
  deleteLoop: agentProcedure
    .input(z.object({ sessionId: z.string(), loopId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({
        where: { id: input.sessionId },
        select: { machineId: true, agentName: true },
      });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      await prisma.agentRequest.create({
        data: {
          machineId: ctx.machine.id,
          kind: 'loop-delete',
          agentName: s.agentName,
          target: input.loopId,
        },
      });
      return { ok: true };
    }),

  send: agentProcedure
    .input(
      z.object({
        sessionId: z.string(),
        // Text is optional when at least one image is attached. We still
        // require AT LEAST ONE of text/images so we never insert empty rows.
        text: z.string().max(64_000).default(''),
        images: z
          .array(
            z.object({
              url: z.string().min(1),
              mimeType: z.string().min(1),
              width: z.number().int().nullable().optional(),
              height: z.number().int().nullable().optional(),
            }),
          )
          // Up to 20 images per message (the composer enforces the same cap client-
          // side, MAX_IMAGES). Anthropic accepts more per request; 20 keeps a single
          // message's payload + the gateway's pane delivery sane.
          .max(20)
          .optional(),
        files: z
          .array(
            z.object({
              url: z.string().min(1),
              mimeType: z.string().min(1),
              name: z.string().min(1).max(256),
            }),
          )
          .max(10)
          .optional(),
        // Provenance, not authorization. Only the Brain's takeover_say tool passes
        // 'brain'; the browser composer never sets it. A machine key is already
        // trusted with everything, so this labels rather than gates — but it is
        // what keeps the Brain's own words out of the USER-PROFILE.md corpus, so it has to
        // be recorded at the point of writing and can't be reconstructed later.
        authoredBy: z.literal('brain').optional(),
        // Set on the Brain's FIRST message of a takeover: what it read the
        // conversation as being for. Surfaced in the chat banner immediately, so a
        // misread is visible in one glance instead of twelve messages.
        goal: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      if (s.closedAt) throw new Error('session is closed');

      // ── Takeover gate ───────────────────────────────────────────────────────
      // Brain-authored: there must BE a live takeover, and it must have road left.
      // This is where the cap is real — a Brain that decides to keep going gets a
      // refusal here, not a stern comment in a skill file.
      const byBrain = input.authoredBy === 'brain';
      if (byBrain) {
        if (!s.takeoverBySessionId) throw new Error('no active takeover on this session');
      }

      const text = input.text.trim();
      const images = input.images ?? [];
      const files = input.files ?? [];
      if (!text && images.length === 0 && files.length === 0) throw new Error('empty message');

      // Queue cap: count this session's WAITING user-composed messages
      // (USER_QUEUE_FILTER excludes the in-flight delivered one AND the agent's
      // transcript rows). The composer also pre-disables at QUEUE_LIMIT; this is
      // the server backstop for races.
      const waiting = await prisma.chatMessage.count({
        where: { sessionId: input.sessionId, ...USER_QUEUE_FILTER },
      });
      if (waiting >= QUEUE_LIMIT) throw new Error('queue_full');

      // Anthropic-style content blocks: text first (matches user's mental
      // model of "I typed, then attached"), then each image as a source.url
      // block. Gateway picks these up via pollPending and feeds claude.
      const content: Array<Record<string, unknown>> = [];
      if (text) content.push({ type: 'text', text });
      for (const img of images) {
        content.push({
          type: 'image',
          source: { type: 'url', url: img.url, media_type: img.mimeType },
          // width/height are non-anthropic but helpful for the dashboard's
          // markdown renderer to size the inline thumbnail before fetch.
          ...(img.width != null && img.height != null
            ? { width: img.width, height: img.height }
            : {}),
        });
      }
      // Non-image files: a `file` block the gateway relay materializes on the
      // Mac and feeds claude via `Read <path>`. `name` aids the dashboard chip.
      for (const f of files) {
        content.push({
          type: 'file',
          source: { type: 'url', url: f.url, media_type: f.mimeType },
          name: f.name,
        });
      }

      const msg = await prisma.chatMessage.create({
        // content is JSON in the DB; prisma wants Prisma.InputJsonValue, the
        // Record-shaped union confuses inference, hence the cast.
        data: {
          sessionId: input.sessionId,
          role: 'user',
          content: stripNulDeep(content) as unknown as Parameters<typeof prisma.chatMessage.create>[0]['data']['content'],
          authoredBy: byBrain ? 'brain' : null,
        },
      });
      // Clear any stale cancel signal from a previous turn so this new
      // turn isn't immediately killed by the gateway.
      await prisma.chatSession.update({
        where: { id: input.sessionId },
        data: {
          lastMessageAt: new Date(),
          cancelRequestedAt: null,
          // Populate the denormalized sidebar preview from the first user text,
          // set once (listSessions/getSession read this column instead of a
          // first-user-message subquery). Existing sessions are backfilled.
          ...(text && !s.preview ? { preview: text.replace(/\s+/g, ' ').trim().slice(0, 120) } : {}),
          // Brain message: spend a turn, and record the goal it inferred (first
          // message only — `goal ||` keeps a later call from rewriting it).
          // The ghost draft has become a real message; clear it either way, so a
          // human message interrupting mid-type doesn't leave the Brain's half-
          // finished sentence sitting in the composer.
          takeoverDraft: null,
          takeoverDraftAt: null,
          ...(byBrain
            ? {
                takeoverTurns: { increment: 1 },
                ...(input.goal?.trim() && !s.takeoverGoal ? { takeoverGoal: input.goal.trim() } : {}),
              }
            : {}),
        },
      });

      // The human typed into a conversation the Brain was driving → they have the
      // wheel back, immediately. Reaching for the keyboard IS the intent; making
      // them find a button first would mean their message lands mid-takeover and
      // races the Brain's next one.
      if (!byBrain && s.takeoverBySessionId) {
        await endTakeover(input.sessionId, 'human');
      }
      return msg;
    }),

  // User clicks Stop on the compose bar. Flips a flag the gateway polls; the
  // gateway then SIGTERMs the in-flight `claude --print` child and writes a
  // "[stopped by user]" system row before clearing the flag via ackCancel.
  cancelTurn: agentProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      await prisma.chatSession.update({
        where: { id: input.sessionId },
        data: { cancelRequestedAt: new Date() },
      });
      return { ok: true };
    }),

  // Pull a single still-queued message out before the gateway sends it. Only an
  // UNDELIVERED user row can go (a delivered one is already in claude's hands —
  // can't un-send). Ownership checked via its session, matching send/cancelTurn.
  dequeue: agentProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const m = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: { id: true, role: true, deliveredAt: true, externalId: true, session: { select: { machineId: true, agentName: true } } },
      });
      if (!m || m.session.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(m.session.agentName);
      // Only a user-composed, still-queued row can be pulled — never a delivered
      // one, and never a transcript row (externalId set ⇒ the agent's own).
      if (m.role !== 'user' || m.deliveredAt || m.externalId) return { removed: false };
      await prisma.chatMessage.delete({ where: { id: input.messageId } });
      return { removed: true };
    }),

  // Empty the whole waiting queue for a session (undelivered user rows only).
  clearQueue: agentProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      const r = await prisma.chatMessage.deleteMany({
        // USER_QUEUE_FILTER, NOT a bare role:'user' — a bare delete would also
        // wipe the agent's transcript tool_result rows out of the conversation.
        where: { sessionId: input.sessionId, ...USER_QUEUE_FILTER },
      });
      return { removed: r.count };
    }),

  // ─── Gateway endpoints ────────────────────────────────────────────────────
  // Active sessions + their unread user messages. Gateway polls this every 2s.
  pollPending: gatewayProcedure.query(async ({ ctx }) => {
    const sessions = await prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, closedAt: null, ...LIVE_SESSION },
      select: {
        id: true, agentName: true, claudeSessionId: true,
        runtime: true, runtimeProvider: true, runtimeModel: true, runtimeMode: true,
      },
    });
    if (sessions.length === 0) return { sessions: [], messages: [] };

    // DB-leader: Agent.directory holds the actual on-disk path (could be inside
    // AGENTS_ROOT for created agents OR a user-given path for imported ones).
    // The gateway needs this to spawn claude in the right cwd — without it the
    // chat-runner used to hardcode `AGENTS_ROOT/<agentName>` and silently fell
    // back to $HOME for imported agents, leaving them stuck "starting".
    const agentNames = [...new Set(sessions.map((s) => s.agentName))];
    const agents = await prisma.agent.findMany({
      where: { machineId: ctx.machine.id, name: { in: agentNames } },
      select: {
        name: true, directory: true, isOrchestrator: true,
        runtime: true, runtimeProvider: true, runtimeModel: true, runtimeMode: true,
      },
    });
    const dirByName = new Map(agents.map((a) => [a.name, a.directory]));
    const orchByName = new Map(agents.map((a) => [a.name, a.isOrchestrator]));
    const runtimeByName = new Map(agents.map((a) => [a.name, a]));

    const sessionsWithDir = sessions.map((s) => ({
      ...s,
      agentDirectory: dirByName.get(s.agentName) ?? null,
      // The orchestrator flag rides along so the gateway can set HERMIT_BRAIN on
      // this session's MCP stub (which unlocks the brain-only cross-agent tools).
      isOrchestrator: orchByName.get(s.agentName) ?? false,
      // Which backend runs this session, resolved here so the gateway never has
      // to know the fallback chain: session's own choice, else the agent's
      // default, else claude-tmux. Provider/model follow whichever level won —
      // a session that picked pi must not inherit the agent's claude settings.
      ...resolveRuntime(s, runtimeByName.get(s.agentName)),
    }));

    const sessionIds = sessions.map((s) => s.id);
    const messages = await prisma.chatMessage.findMany({
      // Only user-composed sends (USER_QUEUE_FILTER) — never the transcript
      // tool_result / image rows the gateway itself synced (those are role:'user'
      // deliveredAt:null too, but carry an externalId). Without this the gateway
      // would try to "deliver" the agent's own attachments back into the pane.
      where: { sessionId: { in: sessionIds }, ...USER_QUEUE_FILTER },
      // Narrow to what the gateway's deliverMessages actually reads — without a
      // select this hauls the full content JSON (text + any image blocks) for
      // every queued row on the 2s chatTick AND the 8s snapshot poll.
      select: { id: true, sessionId: true, content: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return { sessions: sessionsWithDir, messages };
  }),

  ackDelivered: gatewayProcedure
    .input(z.object({ messageIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      if (input.messageIds.length === 0) return { ok: true, updated: 0 };
      const r = await prisma.chatMessage.updateMany({
        where: {
          id: { in: input.messageIds },
          session: { machineId: ctx.machine.id },
        },
        data: { deliveredAt: new Date() },
      });
      return { ok: true, updated: r.count };
    }),

  // Gateway polls this every ~1.5s during turns. Returns sessions where the
  // user has clicked Stop. Gateway kills the matching child + acks.
  pollCancellations: gatewayProcedure.query(async ({ ctx }) => {
    const rows = await prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, cancelRequestedAt: { not: null } },
      select: { id: true, cancelRequestedAt: true },
    });
    return rows;
  }),

  ackCancel: gatewayProcedure
    .input(z.object({ sessionIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      if (input.sessionIds.length === 0) return { ok: true, updated: 0 };
      const r = await prisma.chatSession.updateMany({
        where: { id: { in: input.sessionIds }, machineId: ctx.machine.id },
        data: { cancelRequestedAt: null },
      });
      return { ok: true, updated: r.count };
    }),

  // Per-session restart. Kills the tmux pane backing this ChatSession; the
  // next user message will respawn `claude --resume <claudeSessionId>` so
  // history is preserved. Used when claude is wedged, MCP went stale, etc.
  requestSessionRestart: agentProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      await prisma.chatSession.update({
        where: { id: input.id },
        data: { restartRequestedAt: new Date() },
      });
      return { ok: true };
    }),

  // Gateway polls every ~2s. Each returned session id triggers a tmux
  // `kill(sessionId)` then `ackSessionRestart`.
  pollSessionRestarts: gatewayProcedure.query(async ({ ctx }) => {
    const rows = await prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, restartRequestedAt: { not: null } },
      select: { id: true, restartRequestedAt: true },
    });
    return rows;
  }),

  ackSessionRestart: gatewayProcedure
    .input(z.object({ sessionIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      if (input.sessionIds.length === 0) return { ok: true, updated: 0 };
      const r = await prisma.chatSession.updateMany({
        where: { id: { in: input.sessionIds }, machineId: ctx.machine.id },
        data: { restartRequestedAt: null },
      });
      return { ok: true, updated: r.count };
    }),

  // ── Hibernation (resource governance) ───────────────────────────────────────
  // Manual hibernate from the session context menu: kill the ~500MB claude pane
  // to free memory, keeping claudeSessionId + transcript so the next message
  // respawns via --resume. Sets hibernateRequestedAt; the gateway's hibernate
  // tick does the kill + stamps hibernatedAt. Mirrors requestSessionRestart.
  // Archive one session by hand — the manual twin of what the sweep does, and the
  // replacement for the old `requestHibernate`.
  //
  // Hibernating without archiving was the one remaining way to hand-produce the
  // state this whole feature exists to eliminate: a session asleep and yet still
  // sitting in the sidebar looking live. The automatic mechanism that did that was
  // retired in 20260809210000; this is the manual one. `hibernateRequestedAt` is
  // still how the process gets freed — it just isn't a user-facing concept any more.
  archiveSession: agentProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(s.agentName);
      const now = new Date();
      await prisma.chatSession.update({
        where: { id: input.id },
        // closedAt only if it isn't already archived: re-archiving an archived
        // session must not restart the recycle bin's "archived a month ago" clock.
        data: { hibernateRequestedAt: now, ...(s.closedAt ? {} : { closedAt: now }) },
      });
      return { ok: true };
    }),

  // Gateway polls for pane kills to perform (archive, manual or swept →
  // hibernateRequestedAt → kill pane → ackHibernated).
  pollHibernations: gatewayProcedure.query(async ({ ctx }) => {
    return prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, hibernateRequestedAt: { not: null } },
      select: { id: true },
    });
  }),

  // Every session this machine owns — the gateway's orphan-pane sweep diffs it
  // against the live `hermit-*` tmux sessions to find panes NO row points at.
  //
  // Those exist because deleting a session removes the row while its ~100-500MB
  // claude keeps running, and every pane-killing path (hibernate / reap) is driven
  // by a DB row: no row, no killer, forever. Measured on mac001 2026-08-09: 13
  // orphan panes, 1.54 GB, idle up to 8.6 days. See docs/session-cleanup-design.md.
  //
  // Deliberately EVERY row — closed, hibernated and trashed included. "Known" here
  // means "some row still accounts for it", which is the only question the sweep
  // asks; a hibernated session has no pane to begin with, and a trashed one's pane
  // belongs to the purge pipeline, not to the sweep.
  // `transcriptPath` rides along for the transcript-usage report, which asks the
  // same question of the disk that the pane sweep asks of tmux: what is still
  // accounted for? One poll serves both.
  knownSessions: gatewayProcedure.query(async ({ ctx }) => {
    return prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id },
      select: { id: true, transcriptPath: true },
    });
  }),

  // Gateway acks a kill (a cleanup archive, or a manual hibernate): mark hibernated
  // + dead + clear the request flag. claudeSessionId + transcript are kept, so the
  // next user message respawns with --resume (the snapshot route clears
  // hibernatedAt once the pane is back up).
  ackHibernated: gatewayProcedure
    .input(z.object({ sessionIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      if (input.sessionIds.length === 0) return { ok: true, updated: 0 };
      const r = await prisma.chatSession.updateMany({
        where: { id: { in: input.sessionIds }, machineId: ctx.machine.id },
        data: { hibernatedAt: new Date(), alive: false, hibernateRequestedAt: null },
      });
      return { ok: true, updated: r.count };
    }),

  // ── Session cleanup (docs/session-cleanup-design.md) ───────────────────────

  // What one click would do, and why, without doing any of it. Splits into the
  // reversible tiers (applied immediately by `cleanupApply`) and the trash list
  // (which the human confirms first), plus the sessions that WOULD have been old
  // enough but are spared — that last group is the point: it makes the guardrails
  // visible instead of leaving you to trust them.
  cleanupPreview: agentProcedure
    .input(
      z.preprocess((v) => (v == null ? undefined : v), z.object({
        archiveIdleDays: z.number().int().min(1).max(3650).optional(),
        trashIdleDays: z.number().int().min(1).max(3650).optional(),
      }).default({})),
    )
    .query(async ({ ctx, input }) => {
      const verdicts = await computeCleanup(ctx.machine.id, {
        // The machine's dial is the default, not DEFAULT_ARCHIVE_IDLE_DAYS: with the
        // reaper gone this is the single threshold in the system, and a preview that
        // quietly used 14d while the machine was set to 3d would describe a cleanup
        // nobody was going to run.
        archiveIdleDays: input.archiveIdleDays ?? ctx.machine.cleanupIdleDays ?? undefined,
        trashIdleDays: input.trashIdleDays,
        agentName: ctx.scopedAgent ?? null,
      });
      const trashed = await prisma.chatSession.count({
        where: { machineId: ctx.machine.id, trashedAt: { not: null }, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
      });
      const total = await prisma.chatSession.count({
        where: { machineId: ctx.machine.id, trashedAt: null, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
      });
      return {
        total,
        trashed,
        maxPerRun: MAX_PER_RUN,
        defaults: { archiveIdleDays: DEFAULT_ARCHIVE_IDLE_DAYS, trashIdleDays: DEFAULT_TRASH_IDLE_DAYS },
        archive: verdicts.filter((v) => v.tier === 'archive'),
        trash: verdicts.filter((v) => v.tier === 'trash'),
        spared: verdicts.filter((v) => v.tier === 'keep'),
      };
    }),

  // Run the REVERSIBLE half of a cleanup: hibernate the quiet-but-awake, archive
  // the long-idle. Deliberately cannot trash anything — the irreversible rung is
  // `trashSessions` with an explicit, human-reviewed id list, so a bug here (or a
  // mis-set threshold) costs a `reopen`, never a conversation.
  cleanupApply: machineProcedure
    .input(
      z.preprocess((v) => (v == null ? undefined : v), z.object({
        archiveIdleDays: z.number().int().min(1).max(3650).optional(),
        trashIdleDays: z.number().int().min(1).max(3650).optional(),
      }).default({})),
    )
    .mutation(async ({ ctx, input }) => {
      const verdicts = await computeCleanup(ctx.machine.id, {
        archiveIdleDays: input.archiveIdleDays ?? ctx.machine.cleanupIdleDays ?? undefined,
        trashIdleDays: input.trashIdleDays,
      });
      const archived = await archiveSessions(ctx.machine.id, verdicts);
      await recordCleanupRun(ctx.machine.id, { archived, auto: false });
      return { ok: true, archived };
    }),

  // Auto cleanup. Called by the gateway on a slow tick and gated on the machine's
  // cleanupIdleDays; does the SAME reversible work as cleanupApply and nothing
  // more. There is deliberately no automatic path to the bin: sleeping and
  // archiving cost a click to undo, and everything past that is a decision a
  // person should be present for.
  runCleanupSweep: gatewayProcedure.mutation(async ({ ctx }) => {
    const idleDays = ctx.machine.cleanupIdleDays;
    if (idleDays == null) return { ok: true, archived: 0, skipped: 'disabled' as const };
    const verdicts = await computeCleanup(ctx.machine.id, { archiveIdleDays: idleDays });
    const archived = await archiveSessions(ctx.machine.id, verdicts);
    if (archived === 0) return { ok: true, archived: 0 };
    await recordCleanupRun(ctx.machine.id, { archived, auto: true });
    return { ok: true, archived };
  }),

  // Machine-level cleanup settings, read by the Settings → System card.
  cleanupConfig: machineProcedure.query(async ({ ctx }) => ({
    cleanupIdleDays: ctx.machine.cleanupIdleDays,
    trashRetainDays: ctx.machine.trashRetainDays,
    lastCleanupAt: ctx.machine.lastCleanupAt,
    lastCleanupSummary: ctx.machine.lastCleanupSummary as { archived?: number; trashed?: number; auto?: boolean } | null,
  })),

  setCleanupConfig: machineProcedure
    .input(z.object({
      cleanupIdleDays: z.number().int().positive().max(3650).nullable().optional(),
      trashRetainDays: z.number().int().min(1).max(365).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await prisma.machine.update({
        where: { id: ctx.machine.id },
        data: {
          ...(input.cleanupIdleDays !== undefined ? { cleanupIdleDays: input.cleanupIdleDays } : {}),
          ...(input.trashRetainDays !== undefined ? { trashRetainDays: input.trashRetainDays } : {}),
        },
      });
      return { ok: true };
    }),

  // Move sessions to the recycle bin — the ONLY path the UI should use to get rid
  // of a conversation.
  //
  // The invariant that makes bulk cleanup safe lives here: a trashed session that
  // still has a pane is ALSO flagged for hibernation, so its claude is killed by
  // the existing tick long before the purge deletes the row. Delete-then-orphan
  // (the failure mode `deleteSession` has) becomes structurally impossible,
  // because by the time anything is deleted the pane is already gone.
  //
  // agentProcedure, not machineProcedure: this REPLACED `deleteSession` as the UI's
  // delete action, and that was agent-scoped — a share link must not lose the
  // ability to get rid of its own agent's conversations. Scoped by loading the rows
  // and asserting each agentName (pattern 2 in trpc.ts).
  trashSessions: agentProcedure
    .input(z.object({
      ids: z.array(z.string()).min(1).max(MAX_PER_RUN),
      reason: z.string().max(32).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const rows = await prisma.chatSession.findMany({
        where: { id: { in: input.ids }, machineId: ctx.machine.id, trashedAt: null },
        select: { id: true, alive: true, agentName: true },
      });
      for (const r of rows) ctx.assertAgent(r.agentName);
      if (rows.length === 0) return { ok: true, trashed: 0 };
      const now = new Date();
      await prisma.chatSession.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, machineId: ctx.machine.id },
        data: { trashedAt: now, trashReason: (input.reason as CleanupReason) ?? 'manual' },
      });
      const stillUp = rows.filter((r) => r.alive).map((r) => r.id);
      if (stillUp.length > 0) {
        await prisma.chatSession.updateMany({
          where: { id: { in: stillUp }, machineId: ctx.machine.id },
          data: { hibernateRequestedAt: now },
        });
      }
      await recordCleanupRun(ctx.machine.id, { trashed: rows.length, auto: false });
      return { ok: true, trashed: rows.length, hibernating: stillUp.length };
    }),

  // The recycle bin. Ordered oldest-trashed first — the ones about to be purged
  // are the ones worth looking at.
  listTrashed: agentProcedure.query(async ({ ctx }) => {
    const rows = await prisma.chatSession.findMany({
      where: {
        machineId: ctx.machine.id,
        trashedAt: { not: null },
        ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}),
      },
      orderBy: { trashedAt: 'asc' },
      take: 200,
      select: {
        id: true, agentName: true, title: true, preview: true, trashedAt: true,
        trashReason: true, lastMessageAt: true, rssMb: true, contextTokens: true,
      },
    });
    return { rows, retainDays: ctx.machine.trashRetainDays };
  }),

  // Take one back out of the bin. Restores it to exactly what it was — archived if
  // it was archived, open if it was open — because trashing never touched closedAt.
  restoreSession: agentProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const r = await prisma.chatSession.updateMany({
        // scopedAgent-constrained WHERE (pattern 3): a scoped key simply matches
        // nothing outside its own agent, so count===0 and the call is a no-op.
        where: { id: input.id, machineId: ctx.machine.id, trashedAt: { not: null }, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
        data: { trashedAt: null, trashReason: null },
      });
      return { ok: r.count > 0 };
    }),

  // "Never propose this one again." Also lifts it out of the bin if it is in there,
  // since the whole point is that this session should stop being a candidate.
  keepSession: agentProcedure
    .input(z.object({ id: z.string(), keep: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const r = await prisma.chatSession.updateMany({
        where: { id: input.id, machineId: ctx.machine.id, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
        data: input.keep
          ? { keepAt: new Date(), trashedAt: null, trashReason: null }
          : { keepAt: null },
      });
      return { ok: r.count > 0 };
    }),

  // Skip the retention wait for one session. Doesn't delete anything itself —
  // it back-dates trashedAt so the gateway's purge poll picks it up on the next
  // tick, which keeps ONE code path (pane-confirmed-dead → delete) instead of a
  // second one that could delete a row while its pane is still up.
  purgeNow: agentProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const r = await prisma.chatSession.updateMany({
        where: { id: input.id, machineId: ctx.machine.id, trashedAt: { not: null }, ...(ctx.scopedAgent ? { agentName: ctx.scopedAgent } : {}) },
        data: { trashedAt: new Date(0) },
      });
      return { ok: r.count > 0 };
    }),

  // Gateway: sessions whose time in the bin is up. It confirms the pane is gone
  // (killing it first if not), deletes the transcript, then calls ackPurged.
  //
  // transcriptPath rides along because it is the ONLY safe way to delete a
  // transcript: ~/.claude/projects holds every claude run on the host, including
  // the user's own terminal sessions, so age or directory alone can never justify
  // deleting a file. We delete a transcript when we still hold the row that
  // claims it, and never otherwise.
  pollPurgeDue: gatewayProcedure.query(async ({ ctx }) => {
    const retainDays = ctx.machine.trashRetainDays;
    const cutoff = new Date(Date.now() - retainDays * 86_400_000);
    return prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, trashedAt: { not: null, lt: cutoff } },
      select: { id: true, transcriptPath: true, claudeSessionId: true },
      take: 50,
    });
  }),

  // Gateway confirms the pane is dead and the transcript is gone → drop the row.
  // ChatMessage / Interaction cascade on their FKs; Cron.reportSessionId is
  // SET NULL, which is why a cron pointing here is a hard blocker upstream — by
  // the time we get here nothing should be pointing at these rows at all.
  ackPurged: gatewayProcedure
    .input(z.object({ sessionIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      if (input.sessionIds.length === 0) return { ok: true, purged: 0 };
      const r = await prisma.chatSession.deleteMany({
        where: { id: { in: input.sessionIds }, machineId: ctx.machine.id, trashedAt: { not: null } },
      });
      return { ok: true, purged: r.count };
    }),

  // ── Brain dispatch-watcher (docs/brain-design.md Phase 2) ──────────────────
  // Called by the gateway on a slow tick. The Brain delegates work to other agents
  // but only wakes on its own schedule, so it used to miss two things: a dispatched
  // agent BLOCKING on a choice (can't continue without an answer) and a dispatched
  // agent FINISHING (its result never gets pulled). This closes the loop
  // reactively: for each open dispatch a Brain opened, compute the current
  // "needs-Brain?" signature and, on a transition into blocked/finished, drop a
  // `[dispatch update]` user message into the Brain's OWN chat session (the normal
  // delivery pipeline types it into the Brain's pane). dispatchNotify dedups so
  // each transition pokes exactly once — never every tick. A narrow filtered query
  // + writes only on change → no full-table scan, no per-tick churn.
  runDispatchWatch: gatewayProcedure.mutation(async ({ ctx }) => {
    const rows = await prisma.chatSession.findMany({
      where: {
        machineId: ctx.machine.id,
        origin: 'dispatch',
        closedAt: null,
        dispatchedBySessionId: { not: null },
        ...LIVE_SESSION,
      },
      select: { id: true, agentName: true, state: true, dispatchNotify: true, dispatchedBySessionId: true },
    });
    if (rows.length === 0) return { scanned: 0, poked: 0 };

    let poked = 0;
    for (const r of rows) {
      // Oldest pending interaction = the choice this dispatch is parked on.
      const pending = await prisma.interaction.findFirst({
        where: { sessionId: r.id, status: 'pending' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, kind: true, payload: true },
      });

      let sig: string;
      let poke: string | null = null;
      if (pending) {
        sig = `blocked:${pending.id}`;
        const pl = (pending.payload ?? {}) as Record<string, unknown>;
        if (pending.kind === 'permission') {
          const toolName = typeof pl.tool === 'string' ? pl.tool : '?';
          poke =
            `[dispatch update] ${r.agentName} is BLOCKED — it wants to run tool "${toolName}". ` +
            `Answer with dispatch_answer({ sessionId: "${r.id}", approve: true|false }) — deciding is the default. ` +
            `Only the five on your floor go to the human (destructive/irreversible, costly, ` +
            `secrets·DNS·TLS·billing, outward-facing, their own commitments); "I'm unsure" is not one of them, ` +
            `and neither is a routine redeploy of committed code through the project's own deploy path.`;
        } else {
          const questionText = typeof pl.question === 'string' ? pl.question : '';
          const rawOptions = Array.isArray(pl.options) ? pl.options : [];
          const opts = rawOptions
            .map((o) =>
              typeof o === 'string'
                ? o
                : o && typeof o === 'object' && 'label' in o
                  ? String((o as { label: unknown }).label)
                  : '',
            )
            .filter(Boolean)
            .slice(0, 12);
          poke =
            `[dispatch update] ${r.agentName} is BLOCKED on a question: "${questionText.slice(0, 300)}". ` +
            (opts.length ? `Options: ${opts.join(' | ')}. ` : '') +
            `Answer with dispatch_answer({ sessionId: "${r.id}", answer: "…" }) — escalate only if answering it would cross your floor.`;
        }
      } else if (r.state !== 'working') {
        // Settled (not mid-turn): if there's an assistant reply, treat the newest
        // one as "finished this turn". Keyed on the message id so a stable reply
        // doesn't re-poke, but a NEW reply (a later turn) does.
        const lastA = await prisma.chatMessage.findFirst({
          where: { sessionId: r.id, role: 'assistant' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (lastA) {
          sig = `done:${lastA.id}`;
          poke =
            `[dispatch update] ${r.agentName} finished a turn (session ${r.id}). ` +
            `Read it with dispatch_result({ sessionId: "${r.id}" }), then decide the next step or close it with dispatch_close.`;
        } else {
          sig = 'idle';
        }
      } else {
        sig = 'working';
      }

      if (sig === r.dispatchNotify) continue; // no transition — nothing to do
      // Record the new signature regardless, so non-notable flips (working/idle)
      // don't re-fire and the NEXT notable transition is detected cleanly.
      await prisma.chatSession.update({ where: { id: r.id }, data: { dispatchNotify: sig } });
      if (!poke) continue; // working/idle: recorded only, no poke

      // Deliver the poke into the Brain session that owns this dispatch — but only
      // if it's still open (a closed Brain chat can't act on it). Via pokeSession,
      // which stamps authoredBy:'system': these are role 'user' rows, so unmarked
      // they would read as things the human typed and skew the USER-PROFILE.md corpus.
      if (await pokeSession(r.dispatchedBySessionId!, ctx.machine.id, poke)) poked++;
    }
    return { scanned: rows.length, poked };
  }),

  // ── Brain takeover ─────────────────────────────────────────────────────────
  // The human hands a conversation they were already having to the Brain, which
  // then talks to the agent for them. See docs/brain-takeover-design.md.

  // Start a takeover. machineProcedure, NOT agentProcedure: a scoped agent-share
  // key must not be able to hand its one agent to the machine-wide Brain — the
  // Brain would then be acting inside a boundary the share link was drawn to
  // exclude.
  requestTakeover: machineProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      if (s.closedAt) throw new Error('session is closed');
      if (s.takeoverBySessionId) return { ok: true, already: true as const };

      const brainAgent = await findBrainAgent(ctx.machine.id);
      if (!brainAgent) throw new Error('no Brain is set up on this machine');
      // Handing the Brain a conversation with itself would make it its own driver
      // and its own driven — an immediate poke loop with nothing to accomplish.
      if (s.agentName === brainAgent.name) throw new Error('the Brain cannot take over its own conversation');

      const live = await prisma.chatSession.count({
        where: { machineId: ctx.machine.id, takeoverBySessionId: { not: null } },
      });
      if (live >= TAKEOVER_CONCURRENCY) {
        throw new Error(`too many live takeovers (${TAKEOVER_CONCURRENCY}) — release one first`);
      }

      // A DEDICATED Brain session per takeover.
      //
      // This used to reuse the Brain's most recently active conversation, which was
      // wrong three ways: it injected `[takeover update]` pokes and the Brain's
      // driving reasoning into whatever the human was discussing with it at the time;
      // several concurrent takeovers all landed in one context, leaving the Brain to
      // keep unrelated jobs straight; and "most recently active" moves as the human
      // chats, so which session a takeover landed in was effectively arbitrary.
      //
      // One conversation driven, one Brain session driving it. Marked
      // origin:'takeover' so the Brain panel and the sidebar leave it alone — like
      // origin:'dispatch' before it — and so the daily dream can reap the finished
      // ones.
      const brainSession = await prisma.chatSession.create({
        data: {
          machineId: ctx.machine.id,
          agentName: brainAgent.name,
          title: `Takeover · ${s.agentName}`,
          origin: 'takeover',
        },
        select: { id: true },
      });

      await prisma.chatSession.update({
        where: { id: input.sessionId },
        data: {
          takeoverBySessionId: brainSession.id,
          takeoverStartedAt: new Date(),
          takeoverTurns: 0,
          takeoverGoal: null,
          takeoverNotify: null,
        },
      });
      await prisma.chatMessage.create({
        data: { sessionId: input.sessionId, role: 'system', content: asContent([{ type: 'text', text: startNote() }]) },
      });

      await pokeSession(
        brainSession.id,
        ctx.machine.id,
        `[takeover] The human handed you their conversation with ${s.agentName} (session ${input.sessionId}). ` +
          `Read it with takeover_read({ sessionId: "${input.sessionId}" }), work out what it is trying to achieve, ` +
          `then drive it with takeover_say — passing that goal on your FIRST message so the human can see your reading. ` +
          `Drive it until the goal is met, then release it with takeover_release. There is no message budget — ` +
          `take as many turns as the work needs, and stop when it's done, when you hit the safety floor, or when ` +
          `the agent is genuinely going in circles.`,
      );
      return { ok: true, already: false as const, brainSessionId: brainSession.id };
    }),

  // The Brain announcing what it is ABOUT to send. The composer renders this ghosted
  // for a few seconds before the message actually lands, which is what turns a Brain
  // turn from "a message appeared" into something you watched being typed — and gives
  // you a beat to take the wheel back first.
  //
  // Best-effort by design: it only decorates. A failure here must never stop the
  // Brain from actually saying its piece, and a stale draft is cleared by the next
  // send, a release, or the watcher.
  setTakeoverDraft: machineProcedure
    .input(z.object({ sessionId: z.string(), text: z.string().max(4000).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const text = input.text?.trim() || null;
      await prisma.chatSession.updateMany({
        // Only while a takeover is live — nothing else may put words in the composer.
        where: { id: input.sessionId, machineId: ctx.machine.id, takeoverBySessionId: { not: null } },
        data: { takeoverDraft: text, takeoverDraftAt: text ? new Date() : null },
      });
      return { ok: true };
    }),

  // Hand the conversation back. Used by the banner's Release button and by the
  // Brain's takeover_release tool.
  releaseTakeover: machineProcedure
    .input(
      z.object({
        sessionId: z.string(),
        summary: z.string().max(500).optional(),
        // 'human' when a person clicked Release; 'done' when the Brain judged the
        // goal met. Anything else is decided server-side by the caps.
        reason: z.enum(['human', 'done']).default('human'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({
        where: { id: input.sessionId },
        select: { machineId: true },
      });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      const ended = await endTakeover(input.sessionId, input.reason, input.summary);
      return { ok: true, ended };
    }),

  // The Brain's view of what it is currently driving. Also what the sidebar could
  // use later; for now it backs the takeover_list tool.
  listTakeovers: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, takeoverBySessionId: { not: null } },
      select: {
        id: true,
        agentName: true,
        title: true,
        state: true,
        takeoverGoal: true,
        takeoverTurns: true,
        takeoverStartedAt: true,
      },
      orderBy: { takeoverStartedAt: 'asc' },
    });
    return rows;
  }),

  // ── USER-PROFILE.md corpus ─────────────────────────────────────────────────────────

  // Everything the human typed on this machine after `since`, oldest first. Backs
  // the Brain's `user_messages` tool, which folds each batch into USER-PROFILE.md and
  // records the watermark in the file itself — so this stays stateless and there's
  // no DB/file sync to drift. See server/user-profile.ts for why the filter is
  // as paranoid as it is.
  humanMessages: machineProcedure
    .input(
      z.object({
        since: z.coerce.date().nullish(),
        limit: z.number().int().min(1).max(HUMAN_MESSAGES_MAX).default(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      return humanMessages(ctx.machine.id, { since: input.since, limit: input.limit });
    }),

  // The Persona panel's "Regenerate" button. Nudges the Brain to redo its read of
  // the human now instead of waiting for the nightly dream.
  requestUserProfileRefresh: machineProcedure.mutation(async ({ ctx }) => {
    const brainAgent = await findBrainAgent(ctx.machine.id);
    if (!brainAgent) throw new Error('no Brain is set up on this machine');
    const brainSession = await prisma.chatSession.findFirst({
      where: { machineId: ctx.machine.id, agentName: brainAgent.name, closedAt: null },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      select: { id: true },
    });
    if (!brainSession) throw new Error('the Brain has no open conversation to work in');
    const ok = await pokeSession(
      brainSession.id,
      ctx.machine.id,
      '[user profile] Refresh USER-PROFILE.md now, following the "Read the human" step of your `dreaming` skill: ' +
        'read USER-PROFILE.md for its synced-through watermark, pull the new messages with user_messages, ' +
        'fold them into the existing read rather than rewriting it, and update the watermark.',
    );
    return { ok };
  }),

  // Gateway tick. Same contract as runDispatchWatch — compute a "needs Brain?"
  // signature per live takeover, poke only on a transition — with one addition: it
  // is also where the caps are swept, so a takeover whose Brain simply stopped
  // talking still gets handed back instead of sitting open forever.
  runTakeoverWatch: gatewayProcedure.mutation(async ({ ctx }) => {
    const rows = await prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, takeoverBySessionId: { not: null } },
      select: {
        id: true,
        agentName: true,
        state: true,
        closedAt: true,
        takeoverNotify: true,
        takeoverBySessionId: true,
        takeoverTurns: true,
        takeoverStartedAt: true,
        takeoverGoal: true,
      },
    });
    // Reap the Brain-side scaffolding. Each takeover gets its own Brain session, so
    // without this they accumulate one live claude process per takeover ever started.
    // Only ones with no takeover still pointing at them, and idle for a while — the
    // Brain calls takeover_release from INSIDE its session, so closing the moment a
    // takeover ends would cut off the turn that ended it.
    const REAP_IDLE_MS = 5 * 60_000;
    const stale = await prisma.chatSession.findMany({
      where: {
        machineId: ctx.machine.id,
        origin: 'takeover',
        closedAt: null,
        ...LIVE_SESSION,
        lastMessageAt: { lt: new Date(Date.now() - REAP_IDLE_MS) },
        NOT: { state: 'working' },
      },
      select: { id: true },
    });
    if (stale.length > 0) {
      const live = new Set(rows.map((r) => r.takeoverBySessionId));
      const done = stale.filter((x) => !live.has(x.id)).map((x) => x.id);
      if (done.length > 0) {
        await prisma.chatSession.updateMany({ where: { id: { in: done } }, data: { closedAt: new Date() } });
      }
    }

    if (rows.length === 0) return { scanned: 0, poked: 0, ended: 0 };

    let poked = 0;
    let ended = 0;
    for (const r of rows) {
      if (r.closedAt) {
        if (await endTakeover(r.id, 'closed')) ended++;
        continue;
      }
      const pending = await prisma.interaction.findFirst({
        where: { sessionId: r.id, status: 'pending' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, kind: true },
      });

      let sig: string;
      let poke: string | null = null;
      if (pending) {
        sig = `blocked:${pending.id}`;
        poke =
          `[takeover update] ${r.agentName} is BLOCKED on a ${pending.kind} in the conversation you're driving ` +
          `(session ${r.id}). Answer it with dispatch_answer({ sessionId: "${r.id}", … }) — you are driving, so deciding ` +
          `is the default, and that includes shipping what you just finished. Release the takeover ONLY for the five on ` +
          `your floor (destructive/irreversible, costly, secrets·DNS·TLS·billing, outward-facing, their own commitments); ` +
          `"I'm unsure" and "this is taking a while" are not on that list.`;
      } else if (r.state !== 'working') {
        const lastA = await prisma.chatMessage.findFirst({
          where: { sessionId: r.id, role: 'assistant' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (lastA) {
          sig = `done:${lastA.id}`;
          poke =
            `[takeover update] ${r.agentName} finished a turn in the conversation you're driving (session ${r.id}). ` +
            `Read it with takeover_read, then either send the next message with takeover_say ` +
            `or, if ${r.takeoverGoal ? `"${r.takeoverGoal.slice(0, 160)}"` : 'the goal'} is met, call takeover_release with a short summary.`;
        } else {
          sig = 'idle';
        }
      } else {
        sig = 'working';
      }

      if (sig === r.takeoverNotify) continue;
      await prisma.chatSession.update({ where: { id: r.id }, data: { takeoverNotify: sig } });
      if (!poke) continue;
      if (await pokeSession(r.takeoverBySessionId!, ctx.machine.id, poke)) poked++;
    }
    return { scanned: rows.length, poked, ended };
  }),
});
