// Direct dashboard ↔ agent chat. Sessions live in DB; gateway tails
// `pendingMessages` (user rows without deliveredAt) every couple seconds,
// hands them to the Anthropic SDK, then POSTs assistant rows back via
// /api/sync/chat-message. Browser tails messages via tRPC refetch (1s).

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { QUEUE_LIMIT } from '../../lib/chat-queue';
import { stripNulDeep } from '../sanitize';
import { capMessageContent } from '../message-cap';

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

export const chatRouter = router({
  listSessions: machineProcedure
    // Tolerate a `null` input (some client paths serialize an omitted/undefined
    // arg as JSON null in the GET batch → zod's `.default({})` only fills
    // undefined, so null 400'd: 3 failed listSessions per page load + retries).
    // null/undefined both mean "no agent filter" → normalize to {}.
    .input(z.preprocess((v) => (v == null ? undefined : v), z.object({ agentName: z.string().optional() }).default({})))
    .query(async ({ ctx, input }) => {
      const rows = await prisma.chatSession.findMany({
        where: {
          machineId: ctx.machine.id,
          ...(input.agentName ? { agentName: input.agentName } : {}),
        },
        orderBy: [{ closedAt: 'asc' }, { lastMessageAt: 'desc' }, { startedAt: 'desc' }],
        select: {
          id: true,
          agentName: true,
          title: true,
          claudeSessionId: true,
          startedAt: true,
          lastMessageAt: true,
          lastReadAt: true,
          closedAt: true,
          restartRequestedAt: true,
          pid: true,
          alive: true,
          state: true,
          contextTokens: true,
          outputTokens: true,
          lastActivity: true,
          snapshotAt: true,
          loopState: true,
          // First user message → "preview" shown in the sidebar so two
          // untitled sessions for the same agent are distinguishable. Limit
          // to one row per session via Prisma's nested `take`.
          messages: {
            where: { role: 'user' },
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { content: true },
          },
        },
      });
      return rows.map((s) => {
        const firstUserBlock = (s.messages[0]?.content as Array<{ type?: string; text?: string }> | undefined)?.find(
          (b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0,
        );
        const preview = firstUserBlock?.text?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? null;
        const { messages: _drop, ...rest } = s;
        return { ...rest, preview };
      });
    }),

  // Mark a session read = now. Was browser localStorage (per-device); now a DB
  // stamp so the red "unread" dot clears on every device (the chat pane fires
  // this on open + on each new message while open; other devices reconcile on
  // their next listSessions poll). Idempotent; silently no-ops for other
  // machines' sessions so a stale tab can't 500.
  markRead: machineProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const res = await prisma.chatSession.updateMany({
        where: { id: input.sessionId, machineId: ctx.machine.id },
        data: { lastReadAt: new Date() },
      });
      return { ok: res.count > 0 };
    }),

  createSession: machineProcedure
    .input(z.object({ agentName: z.string().min(1).max(64), title: z.string().max(120).optional() }))
    .mutation(async ({ ctx, input }) => {
      return prisma.chatSession.create({
        data: { machineId: ctx.machine.id, agentName: input.agentName, title: input.title ?? null },
      });
    }),

  closeSession: machineProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      return prisma.chatSession.update({ where: { id: input.id }, data: { closedAt: new Date() } });
    }),

  reopenSession: machineProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      return prisma.chatSession.update({ where: { id: input.id }, data: { closedAt: null } });
    }),

  // Hard delete a session + its messages (ChatMessage cascades on the FK). The
  // dashboard's "close" action maps to this now. The session's tmux pane (if
  // any) is orphaned — harmless, idle, reclaimed on the next gateway restart;
  // pollPending no longer returns the deleted session so nothing re-spawns it.
  deleteSession: machineProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
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
  appendSystemNote: machineProcedure
    .input(z.object({ sessionId: z.string(), text: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      const content = [{ type: 'text', text: input.text }];
      return prisma.chatMessage.create({
        data: {
          sessionId: input.sessionId,
          role: 'system',
          content: content as unknown as Parameters<typeof prisma.chatMessage.create>[0]['data']['content'],
        },
      });
    }),

  setTitle: machineProcedure
    .input(z.object({ id: z.string(), title: z.string().max(120) }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      return prisma.chatSession.update({ where: { id: input.id }, data: { title: input.title } });
    }),

  listMessages: machineProcedure
    .input(z.object({ sessionId: z.string(), limit: z.number().int().min(1).max(1000).default(300) }))
    .query(async ({ ctx, input }) => {
      // Owner check folded into the WHERE clause — drops the extra
      // chatSession.findUnique round trip. Returns [] for unknown or
      // cross-tenant sessions (vs throwing) — chat UI tolerates that.
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
        where: { sessionId: input.sessionId, session: { machineId: ctx.machine.id } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
        // Only the columns the timeline actually reads (`CachedMsg` in
        // chat/page.tsx) + matches the SSE stream's shape so merge-by-id aligns.
        // Skips deliveredAt/externalId/updatedAt/sessionId — pure per-row overhead
        // multiplied across the window.
        select: { id: true, role: true, content: true, createdAt: true },
      });
      return rows.reverse().map((r) => ({ ...r, content: capMessageContent(r.content) }));
    }),

  // The pending dispatch queue for a session: user messages the gateway hasn't
  // picked up yet (deliveredAt=null), oldest first. Small by construction (capped
  // at QUEUE_LIMIT by `send`). Kept SEPARATE from listMessages so that hot,
  // perf-tuned query keeps skipping deliveredAt. Drives the composer's QueueBar.
  queue: machineProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      return prisma.chatMessage.findMany({
        where: {
          sessionId: input.sessionId,
          session: { machineId: ctx.machine.id },
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
  loopRuns: machineProcedure
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
        select: { machineId: true },
      });
      if (!s || s.machineId !== ctx.machine.id) return [];
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
  deleteLoop: machineProcedure
    .input(z.object({ sessionId: z.string(), loopId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({
        where: { id: input.sessionId },
        select: { machineId: true, agentName: true },
      });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
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

  send: machineProcedure
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
          .max(10)
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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      if (s.closedAt) throw new Error('session is closed');

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
        data: { sessionId: input.sessionId, role: 'user', content: stripNulDeep(content) as unknown as Parameters<typeof prisma.chatMessage.create>[0]['data']['content'] },
      });
      // Clear any stale cancel signal from a previous turn so this new
      // turn isn't immediately killed by the gateway.
      await prisma.chatSession.update({
        where: { id: input.sessionId },
        data: { lastMessageAt: new Date(), cancelRequestedAt: null },
      });
      return msg;
    }),

  // User clicks Stop on the compose bar. Flips a flag the gateway polls; the
  // gateway then SIGTERMs the in-flight `claude --print` child and writes a
  // "[stopped by user]" system row before clearing the flag via ackCancel.
  cancelTurn: machineProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      await prisma.chatSession.update({
        where: { id: input.sessionId },
        data: { cancelRequestedAt: new Date() },
      });
      return { ok: true };
    }),

  // Pull a single still-queued message out before the gateway sends it. Only an
  // UNDELIVERED user row can go (a delivered one is already in claude's hands —
  // can't un-send). Ownership checked via its session, matching send/cancelTurn.
  dequeue: machineProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const m = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: { id: true, role: true, deliveredAt: true, externalId: true, session: { select: { machineId: true } } },
      });
      if (!m || m.session.machineId !== ctx.machine.id) throw new Error('not found');
      // Only a user-composed, still-queued row can be pulled — never a delivered
      // one, and never a transcript row (externalId set ⇒ the agent's own).
      if (m.role !== 'user' || m.deliveredAt || m.externalId) return { removed: false };
      await prisma.chatMessage.delete({ where: { id: input.messageId } });
      return { removed: true };
    }),

  // Empty the whole waiting queue for a session (undelivered user rows only).
  clearQueue: machineProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      const r = await prisma.chatMessage.deleteMany({
        // USER_QUEUE_FILTER, NOT a bare role:'user' — a bare delete would also
        // wipe the agent's transcript tool_result rows out of the conversation.
        where: { sessionId: input.sessionId, ...USER_QUEUE_FILTER },
      });
      return { removed: r.count };
    }),

  // ─── Gateway endpoints ────────────────────────────────────────────────────
  // Active sessions + their unread user messages. Gateway polls this every 2s.
  pollPending: machineProcedure.query(async ({ ctx }) => {
    const sessions = await prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, closedAt: null },
      select: { id: true, agentName: true, claudeSessionId: true },
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
      select: { name: true, directory: true },
    });
    const dirByName = new Map(agents.map((a) => [a.name, a.directory]));

    const sessionsWithDir = sessions.map((s) => ({
      ...s,
      agentDirectory: dirByName.get(s.agentName) ?? null,
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

  ackDelivered: machineProcedure
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
  pollCancellations: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, cancelRequestedAt: { not: null } },
      select: { id: true, cancelRequestedAt: true },
    });
    return rows;
  }),

  ackCancel: machineProcedure
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
  requestSessionRestart: machineProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.id } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      await prisma.chatSession.update({
        where: { id: input.id },
        data: { restartRequestedAt: new Date() },
      });
      return { ok: true };
    }),

  // Gateway polls every ~2s. Each returned session id triggers a tmux
  // `kill(sessionId)` then `ackSessionRestart`.
  pollSessionRestarts: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.chatSession.findMany({
      where: { machineId: ctx.machine.id, restartRequestedAt: { not: null } },
      select: { id: true, restartRequestedAt: true },
    });
    return rows;
  }),

  ackSessionRestart: machineProcedure
    .input(z.object({ sessionIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      if (input.sessionIds.length === 0) return { ok: true, updated: 0 };
      const r = await prisma.chatSession.updateMany({
        where: { id: { in: input.sessionIds }, machineId: ctx.machine.id },
        data: { restartRequestedAt: null },
      });
      return { ok: true, updated: r.count };
    }),
});
