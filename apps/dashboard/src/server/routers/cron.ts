// Cron jobs — user-defined recurring tasks fired by the gateway cron-runner.
// CRUD for the /cron page; `listForGateway` feeds the runner (enabled crons
// joined with their agent's on-disk directory). Results land back via
// /api/sync/cron-run. Each fire is a fresh, throwaway turn in the agent dir, on
// the backend `listForGateway` resolves for it — the same one chat would use.

import { z } from 'zod';
import { router, gatewayProcedure, machineProcedure, agentProcedure } from '../trpc';
import { prisma } from '../db';
import { resolveRuntime, runtimeContextOf } from '../runtime-resolve';
import { retryConfigProblem } from '@/lib/cron-recovery';

// Unread finished runs per cron (status not 'running', readAt null) → the red
// roll-up dot on the sidebar / agent-detail cron rows. One grouped query for the
// whole list; empty in → empty map (groupBy on an empty `in` is wasteful).
async function unreadCountByCron(cronIds: string[]): Promise<Map<string, number>> {
  if (cronIds.length === 0) return new Map();
  const grouped = await prisma.cronRun.groupBy({
    by: ['cronId'],
    where: { cronId: { in: cronIds }, readAt: null, status: { not: 'running' } },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.cronId, g._count._all]));
}

const CronInput = z.object({
  agentName: z.string().min(1).max(64),
  directory: z.string().max(1024).optional(),
  title: z.string().max(120).optional(),
  prompt: z.string().min(1).max(16_000),
  intervalSec: z.number().int().min(60).max(604_800), // 1 min … 7 days
  jitterSec: z.number().int().min(0).max(86_400).default(0),
  enabled: z.boolean().default(true),
  // Where finished runs report. Null keeps a cron silent (visible only in /cron).
  reportSessionId: z.string().nullable().optional(),
  // ── Same-day catch-up after a failed run. OPT-IN, both or neither. ──
  // Deliberately has no default: a cron that sends mail, posts or publishes is
  // doing something irreversible, and a catch-up run of one of those is a
  // duplicate delivery to real people. Coherence is checked below, because the way
  // this setting fails is silence — a window that can never fire looks identical
  // to one that simply has not been needed yet.
  retryEverySec: z.number().int().min(300).max(43_200).nullable().optional(),
  retryWindowSec: z.number().int().min(300).max(86_400).nullable().optional(),
});

/** Refuse a catch-up window that can never fire, rather than storing it. */
function assertRetrySane(a: {
  retryEverySec?: number | null;
  retryWindowSec?: number | null;
  intervalSec: number;
}): void {
  const problem = retryConfigProblem({
    retryEverySec: a.retryEverySec ?? null,
    retryWindowSec: a.retryWindowSec ?? null,
    intervalSec: a.intervalSec,
  });
  if (problem) throw new Error(problem);
}

export const cronRouter = router({
  // All crons for the machine — the /cron page sidebar. `unreadCount` = finished
  // runs the user hasn't read yet (drives the red roll-up dot on the sidebar row).
  // Machine-wide → stays machineProcedure (a scoped share key can't list all
  // agents' crons; the agent-detail panel uses listForAgent instead).
  list: machineProcedure.query(async ({ ctx }) => {
    const crons = await prisma.cron.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: [{ agentName: 'asc' }, { createdAt: 'asc' }],
    });
    const unread = await unreadCountByCron(crons.map((c) => c.id));
    // The list (sidebar, polled every 5s) only uses `prompt` as a label/search
    // fallback when `title` is empty — the FULL prompt for the detail/edit view
    // comes from cron.get. Prompts are @db.Text and dominated this payload (~60%),
    // so cap to a short preview here; trims the bulk of cron.list's bytes/poll.
    const PROMPT_PREVIEW = 100;
    return crons.map((c) => ({
      ...c,
      prompt: c.prompt.length > PROMPT_PREVIEW ? c.prompt.slice(0, PROMPT_PREVIEW) : c.prompt,
      unreadCount: unread.get(c.id) ?? 0,
    }));
  }),

  // All crons for one agent — the agent-detail panel's scheduled-tasks list.
  // Narrow select (no prompt-history / run rows) since it's just a summary list
  // that links out to /cron?id=… for the full detail/edit view.
  listForAgent: agentProcedure
    .input(z.object({ agentName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const crons = await prisma.cron.findMany({
        where: { machineId: ctx.machine.id, agentName: input.agentName },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, title: true, prompt: true, intervalSec: true,
          jitterSec: true, enabled: true, lastStatus: true, lastFire: true, nextFire: true,
          // enabled:false alone can't say WHY it stopped — see the Cron model.
          doneAt: true,
        },
      });
      const unread = await unreadCountByCron(crons.map((c) => c.id));
      return crons.map((c) => ({ ...c, unreadCount: unread.get(c.id) ?? 0 }));
    }),

  // One cron + its recent runs — the detail view (read-only run log).
  get: agentProcedure
    .input(z.object({ id: z.string(), includeRunOutput: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      const cron = await prisma.cron.findUnique({ where: { id: input.id } });
      if (!cron || cron.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(cron.agentName);
      // Run `output` (@db.Text, can be long) shows only when a run row is expanded,
      // so by default keep it OUT of this 5s-polled payload — the /cron rows need
      // just status/timing and lazy-load output via cron.runOutput on expand. The
      // dream journal renders outputs inline, so it opts in with includeRunOutput.
      const runs = await prisma.cronRun.findMany({
        where: { cronId: input.id },
        orderBy: { firedAt: 'desc' },
        take: 50,
        select: {
          id: true, firedAt: true, status: true, durationMs: true, readAt: true,
          ...(input.includeRunOutput ? { output: true } : {}),
        },
      });
      return { cron, runs };
    }),

  // One run's output, fetched lazily when its row is expanded (kept out of the
  // recurring cron.get payload above). Guarded: the run's cron must be this machine's.
  runOutput: agentProcedure.input(z.object({ runId: z.string() })).query(async ({ ctx, input }) => {
    const run = await prisma.cronRun.findUnique({
      where: { id: input.runId },
      select: { output: true, status: true, cron: { select: { machineId: true, agentName: true } } },
    });
    if (!run || run.cron.machineId !== ctx.machine.id) throw new Error('not found');
    ctx.assertAgent(run.cron.agentName);
    return { output: run.output, status: run.status };
  }),

  // Mark one run read = now (clears its red dot). Reading = expanding the run row
  // on the detail page. Guarded: the run's cron must belong to this machine.
  markRunRead: agentProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const run = await prisma.cronRun.findUnique({
        where: { id: input.runId },
        select: { cron: { select: { machineId: true, agentName: true } } },
      });
      if (!run || run.cron.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(run.cron.agentName);
      await prisma.cronRun.update({ where: { id: input.runId }, data: { readAt: new Date() } });
      return { ok: true };
    }),

  // Mark every unread run of a cron read — the detail page's "全部已读" button.
  markAllRead: agentProcedure
    .input(z.object({ cronId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const cron = await prisma.cron.findUnique({ where: { id: input.cronId }, select: { machineId: true, agentName: true } });
      if (!cron || cron.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(cron.agentName);
      const res = await prisma.cronRun.updateMany({
        where: { cronId: input.cronId, readAt: null },
        data: { readAt: new Date() },
      });
      return { ok: true, count: res.count };
    }),

  create: agentProcedure.input(CronInput).mutation(async ({ ctx, input }) => {
    assertRetrySane(input);
    // nextFire = now ⇒ first run on the next gateway tick.
    return prisma.cron.create({
      data: { machineId: ctx.machine.id, ...input, nextFire: new Date() },
    });
  }),

  update: agentProcedure
    .input(z.object({ id: z.string() }).and(CronInput.partial()))
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const existing = await prisma.cron.findUnique({ where: { id } });
      if (!existing || existing.machineId !== ctx.machine.id) throw new Error('not found');
      ctx.assertAgent(existing.agentName);
      // Changing the interval reschedules the next fire from the last run, so a
      // shorter interval runs sooner (and a longer one later) instead of waiting
      // out the old schedule. (A never-fired cron keeps its nextFire = now.)
      const data: Record<string, unknown> = { ...patch };
      if (patch.intervalSec != null && existing.lastFire) {
        data.nextFire = new Date(existing.lastFire.getTime() + patch.intervalSec * 1000);
      }
      // Switching a cron back on revives it, so it is no longer finished. `doneAt`
      // is stamped when a run prints CRON_DONE (api/sync/cron-run) and is the ONLY
      // thing separating 已完成 from 已暂停 — left behind, a re-enabled cron would
      // fire while the page still called it done.
      if (patch.enabled === true) data.doneAt = null;
      // Validate the MERGED row, not the patch: sending only retryWindowSec has to
      // be judged against the interval already stored.
      if (
        patch.retryEverySec !== undefined ||
        patch.retryWindowSec !== undefined ||
        patch.intervalSec != null
      ) {
        assertRetrySane({
          retryEverySec:
            patch.retryEverySec !== undefined ? patch.retryEverySec : existing.retryEverySec,
          retryWindowSec:
            patch.retryWindowSec !== undefined ? patch.retryWindowSec : existing.retryWindowSec,
          intervalSec: patch.intervalSec ?? existing.intervalSec,
        });
        // Turning the window off (or re-cutting the schedule) must not leave a
        // half-finished catch-up pointing at a deadline nobody will honour.
        data.retryUntil = null;
        data.retryCount = 0;
      }
      return prisma.cron.update({ where: { id }, data });
    }),

  delete: agentProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const existing = await prisma.cron.findUnique({ where: { id: input.id } });
    if (!existing || existing.machineId !== ctx.machine.id) throw new Error('not found');
    ctx.assertAgent(existing.agentName);
    await prisma.cron.delete({ where: { id: input.id } }); // CronRuns cascade
    return { ok: true };
  }),

  // Manual fire — set nextFire to NOW so the next gateway cron tick (≤15s) runs
  // it. (Was new Date(0): that epoch sentinel rendered as "1970/1/1" in the UI's
  // "下次" line for the ≤15s window before the gateway fires and recomputes
  // nextFire = now + interval. "now" is ≤ now so it still fires next tick, but
  // reads sensibly if shown — and the UI now labels a due nextFire "即将运行…".)
  runNow: agentProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const existing = await prisma.cron.findUnique({ where: { id: input.id } });
    if (!existing || existing.machineId !== ctx.machine.id) throw new Error('not found');
    ctx.assertAgent(existing.agentName);
    // doneAt unconditionally: asking for a run IS saying it isn't finished, and a
    // cron whose next fire is now must not still be labelled 已完成.
    await prisma.cron.update({
      where: { id: input.id },
      data: { nextFire: new Date(), doneAt: null },
    });
    return { ok: true };
  }),

  // ── Skill-facing (agent calls mcp__hermit__cron_* mid-chat) ───────────────
  // The MCP stub knows only the chat sessionId; resolve agentName from it so a
  // skill-created cron lands on the right agent and shows on /cron like any other.
  createFromSession: agentProcedure
    .input(
      z.object({
        sessionId: z.string(),
        prompt: z.string().min(1).max(16_000),
        intervalSec: z.number().int().min(60).max(604_800),
        jitterSec: z.number().int().min(0).max(86_400).default(0),
        title: z.string().max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const session = await prisma.chatSession.findUnique({
        where: { id: input.sessionId },
        select: { agentName: true, machineId: true },
      });
      if (!session || session.machineId !== ctx.machine.id) throw new Error('session not found');
      ctx.assertAgent(session.agentName);
      return prisma.cron.create({
        data: {
          machineId: ctx.machine.id,
          agentName: session.agentName,
          prompt: input.prompt,
          intervalSec: input.intervalSec,
          jitterSec: input.jitterSec,
          title: input.title,
          // You asked for this schedule in a conversation, so that's where its
          // reports come back. Overridable later via `update`.
          reportSessionId: input.sessionId,
          nextFire: new Date(),
        },
      });
    }),

  listForSession: agentProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const session = await prisma.chatSession.findUnique({
        where: { id: input.sessionId },
        select: { agentName: true, machineId: true },
      });
      if (!session || session.machineId !== ctx.machine.id) return [];
      ctx.assertAgent(session.agentName);
      return prisma.cron.findMany({
        where: { machineId: ctx.machine.id, agentName: session.agentName },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, title: true, prompt: true, intervalSec: true,
          jitterSec: true, enabled: true, lastStatus: true, lastFire: true, doneAt: true,
        },
      });
    }),

  // Crons that REPORT into one chat session — the schedule cards the chat pane
  // shows above the composer next to the loop cards. A different cut from
  // listForSession above: that lists every cron of the session's *agent* (the
  // mcp cron_list tool); this is only the crons whose finished runs land in THIS
  // conversation (reportSessionId), which is what makes them part of the chat.
  // Polled while the pane is open, so: narrow select, preview-capped prompt, and
  // the full prompt + run log come from cron.get once a card is expanded.
  listForReportSession: agentProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const session = await prisma.chatSession.findUnique({
        where: { id: input.sessionId },
        select: { agentName: true, machineId: true },
      });
      if (!session || session.machineId !== ctx.machine.id) return [];
      ctx.assertAgent(session.agentName);
      const crons = await prisma.cron.findMany({
        // agentName pinned to the session's agent: createFromSession keeps report
        // targets within the agent anyway, and the pin means a scoped share key
        // can never see a sibling agent's cron through one of these sessions.
        where: {
          machineId: ctx.machine.id,
          agentName: session.agentName,
          reportSessionId: input.sessionId,
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, title: true, prompt: true, intervalSec: true, jitterSec: true,
          enabled: true, lastStatus: true, lastFire: true, nextFire: true, doneAt: true,
        },
      });
      const unread = await unreadCountByCron(crons.map((c) => c.id));
      const PROMPT_PREVIEW = 100;
      return crons.map((c) => ({
        ...c,
        prompt: c.prompt.length > PROMPT_PREVIEW ? c.prompt.slice(0, PROMPT_PREVIEW) : c.prompt,
        unreadCount: unread.get(c.id) ?? 0,
      }));
    }),

  // Edit a cron in place. The point of "in place" is the PHASE: an agent that rewrites
  // its own prompt must not move its own fire time. delete + create — the only route an
  // agent had before this — resets nextFire to now, so a 09:00 daily report silently
  // becomes a "whenever the agent last edited itself" report. Here only intervalSec
  // reschedules, and it reschedules from lastFire, same rule as `update` above.
  updateFromSession: agentProcedure
    .input(
      z
        .object({
          sessionId: z.string(),
          id: z.string(),
          prompt: z.string().min(1).max(16_000).optional(),
          title: z.string().max(120).optional(),
          intervalSec: z.number().int().min(60).max(604_800).optional(),
          jitterSec: z.number().int().min(0).max(86_400).optional(),
          enabled: z.boolean().optional(),
        })
        // An empty patch would be a silent no-op that still reports success.
        .refine(
          ({ sessionId: _s, id: _i, ...patch }) => Object.values(patch).some((v) => v !== undefined),
          { message: 'nothing to update' },
        ),
    )
    .mutation(async ({ ctx, input }) => {
      const { sessionId, id, ...patch } = input;
      const session = await prisma.chatSession.findUnique({
        where: { id: sessionId },
        select: { agentName: true, machineId: true },
      });
      if (!session || session.machineId !== ctx.machine.id) throw new Error('session not found');
      ctx.assertAgent(session.agentName);
      const cron = await prisma.cron.findUnique({ where: { id } });
      if (!cron || cron.machineId !== ctx.machine.id || cron.agentName !== session.agentName) {
        throw new Error('cron not found for this agent');
      }
      const data: Record<string, unknown> = { ...patch };
      if (patch.intervalSec != null && cron.lastFire) {
        data.nextFire = new Date(cron.lastFire.getTime() + patch.intervalSec * 1000);
      }
      // Same revive rule as `update` above — an agent that switches its own finished
      // cron back on must not leave it reading 已完成.
      if (patch.enabled === true) data.doneAt = null;
      const saved = await prisma.cron.update({ where: { id }, data });
      return {
        id: saved.id,
        title: saved.title,
        intervalSec: saved.intervalSec,
        jitterSec: saved.jitterSec,
        enabled: saved.enabled,
        nextFire: saved.nextFire,
      };
    }),

  deleteFromSession: agentProcedure
    .input(z.object({ sessionId: z.string(), id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const session = await prisma.chatSession.findUnique({
        where: { id: input.sessionId },
        select: { agentName: true, machineId: true },
      });
      if (!session || session.machineId !== ctx.machine.id) throw new Error('session not found');
      ctx.assertAgent(session.agentName);
      const cron = await prisma.cron.findUnique({ where: { id: input.id } });
      if (!cron || cron.machineId !== ctx.machine.id || cron.agentName !== session.agentName) {
        throw new Error('cron not found for this agent');
      }
      await prisma.cron.delete({ where: { id: input.id } });
      return { ok: true };
    }),

  // ── Gateway-facing ────────────────────────────────────────────────────────
  // Enabled crons joined with their agent's stored directory (DB-leader, mirrors
  // chat.pollPending). The cron-runner reads `nextFire`/`lastFire` to decide what
  // is due and fires it in `agentDirectory`.
  listForGateway: gatewayProcedure.query(async ({ ctx }) => {
    const crons = await prisma.cron.findMany({
      where: { machineId: ctx.machine.id, enabled: true },
      // Only the columns the map below actually returns. The response is already
      // projected, so this trims the DB read (drops title / lastStatus / createdAt /
      // updatedAt) for a byte-identical response — the gateway sees no change.
      // `prompt` (@db.Text) stays: the runner needs it to fire. (P3-3)
      select: {
        id: true,
        agentName: true,
        directory: true,
        prompt: true,
        intervalSec: true,
        jitterSec: true,
        enabled: true,
        lastFire: true,
        nextFire: true,
        // Which session this cron reports into — the first source of its runtime
        // (see resolveCronRuntime below).
        reportSessionId: true,
      },
    });
    const names = [...new Set(crons.map((c) => c.agentName))];
    const agents = names.length
      ? await prisma.agent.findMany({
          where: { machineId: ctx.machine.id, name: { in: names } },
          select: {
            name: true, directory: true, isOrchestrator: true,
            // The second resolution level — see the block below.
            runtime: true, runtimeProvider: true, runtimeModel: true, runtimeMode: true,
          },
        })
      : [];
    const dirByName = new Map(agents.map((a) => [a.name, a.directory]));
    const orchByName = new Map(agents.map((a) => [a.name, a.isOrchestrator]));
    const agentByName = new Map(agents.map((a) => [a.name, a]));

    // ── Which backend runs each cron ────────────────────────────────────────
    //
    // The gateway used to receive no runtime signal at all, and cron-runner
    // hard-coded the claude-tmux path. On a machine where claude is not logged
    // in that is not a degraded cron — it is a SILENT one: claude prints
    // "Not logged in" and exits 0, so every fire lands as
    // "no final text", which reads like the task timed out. (dgx-spark,
    // 2026-08-14/15: five consecutive "巡检 timeout" reports, none of them real.)
    //
    // Resolved here rather than in the gateway because every input (the report
    // session's backend, the agent's default, the machine's enabled backends and
    // its credentials) is DB state the gateway does not otherwise hold.
    //
    // This uses the SAME resolveRuntime as chat.pollPending, and that is the
    // whole point. The first version of this block was a hand-rolled two-value
    // guess — the report session's raw `runtime` string, else claude-tmux or
    // codex-exec — written 2026-08-15, six days before backends became "a
    // harness PLUS a credential" (lib/backends.ts). It never caught up, so a
    // cron reporting into a pi+Kimi or dsh+OpenRouter session resolved to that
    // backend's id, hit cron-runner's `!== 'codex-exec'` else-branch, and ran on
    // the Claude subscription instead — silently, because the wrong backend
    // still answers. Sharing the resolver is what stops that drifting apart
    // again: a backend chat can select is now a backend cron can fire on.
    const reportIds = [...new Set(crons.map((c) => c.reportSessionId).filter((x): x is string => !!x))];
    const reportSessions = reportIds.length
      ? await prisma.chatSession.findMany({
          where: { id: { in: reportIds } },
          select: {
            id: true, runtime: true, runtimeProvider: true, runtimeModel: true, runtimeMode: true,
          },
        })
      : [];
    const sessionById = new Map(reportSessions.map((s) => [s.id, s]));
    // `ctx.machine` is the full Machine row (auth.resolveKey selects no columns),
    // so both halves — backendsConfig and modelProviders — are already in hand.
    // The old code issued a second findUnique for backendsConfig alone and had
    // no credentials at all, which is why it could only ever name a harness.
    const backends = runtimeContextOf(ctx.machine);
    return crons.map((c) => {
      // session's own choice > agent's default > the floor. A cron with no report
      // session passes null and lands on its agent's default, which is what
      // "this agent's scheduled work" should mean; the old code ignored the agent
      // entirely and guessed from machine-wide toggles.
      const choice = resolveRuntime(
        c.reportSessionId ? sessionById.get(c.reportSessionId) : null,
        agentByName.get(c.agentName),
        backends,
      );
      return {
        id: c.id,
        agentName: c.agentName,
        agentDirectory: dirByName.get(c.agentName) ?? null,
        // Orchestrator crons run WITH the brain MCP (cron-runner); others headless.
        isOrchestrator: orchByName.get(c.agentName) ?? false,
        directory: c.directory,
        prompt: c.prompt,
        intervalSec: c.intervalSec,
        jitterSec: c.jitterSec,
        enabled: c.enabled,
        lastFire: c.lastFire?.toISOString() ?? null,
        nextFire: c.nextFire?.toISOString() ?? null,
        // `runtime` is the HARNESS to spawn; the rest is what authenticates it and
        // what it runs as. Sending the harness alone is what made a custom backend
        // unrunnable — the gateway knew to start pi but not which key or model.
        // `backendId` is for the log line only: it is the name the user picked in
        // the picker, and a fire that reports "[pi-rpc]" when the card says
        // "pi + Kimi" is the kind of gap that costs an afternoon.
        backendId: choice.backendId,
        runtime: choice.runtime,
        runtimeCredentialId: choice.runtimeCredentialId,
        runtimeProvider: choice.runtimeProvider,
        runtimeModel: choice.runtimeModel,
        runtimeMode: choice.runtimeMode,
      };
    });
  }),
});
