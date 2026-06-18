// Cron jobs — user-defined recurring tasks fired by the gateway cron-runner.
// CRUD for the /cron page; `listForGateway` feeds the runner (enabled crons
// joined with their agent's on-disk directory). Results land back via
// /api/sync/cron-run. Each fire is a fresh tmux + claude turn in the agent dir.

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

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
});

export const cronRouter = router({
  // All crons for the machine — the /cron page sidebar. `unreadCount` = finished
  // runs the user hasn't read yet (drives the red roll-up dot on the sidebar row).
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
  listForAgent: machineProcedure
    .input(z.object({ agentName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const crons = await prisma.cron.findMany({
        where: { machineId: ctx.machine.id, agentName: input.agentName },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, title: true, prompt: true, intervalSec: true,
          jitterSec: true, enabled: true, lastStatus: true, lastFire: true, nextFire: true,
        },
      });
      const unread = await unreadCountByCron(crons.map((c) => c.id));
      return crons.map((c) => ({ ...c, unreadCount: unread.get(c.id) ?? 0 }));
    }),

  // One cron + its recent runs — the detail view (read-only run log).
  get: machineProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const cron = await prisma.cron.findUnique({ where: { id: input.id } });
    if (!cron || cron.machineId !== ctx.machine.id) throw new Error('not found');
    const runs = await prisma.cronRun.findMany({
      where: { cronId: input.id },
      orderBy: { firedAt: 'desc' },
      take: 50,
    });
    return { cron, runs };
  }),

  // Mark one run read = now (clears its red dot). Reading = expanding the run row
  // on the detail page. Guarded: the run's cron must belong to this machine.
  markRunRead: machineProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const run = await prisma.cronRun.findUnique({
        where: { id: input.runId },
        select: { cron: { select: { machineId: true } } },
      });
      if (!run || run.cron.machineId !== ctx.machine.id) throw new Error('not found');
      await prisma.cronRun.update({ where: { id: input.runId }, data: { readAt: new Date() } });
      return { ok: true };
    }),

  // Mark every unread run of a cron read — the detail page's "全部已读" button.
  markAllRead: machineProcedure
    .input(z.object({ cronId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const cron = await prisma.cron.findUnique({ where: { id: input.cronId }, select: { machineId: true } });
      if (!cron || cron.machineId !== ctx.machine.id) throw new Error('not found');
      const res = await prisma.cronRun.updateMany({
        where: { cronId: input.cronId, readAt: null },
        data: { readAt: new Date() },
      });
      return { ok: true, count: res.count };
    }),

  create: machineProcedure.input(CronInput).mutation(async ({ ctx, input }) => {
    // nextFire = now ⇒ first run on the next gateway tick.
    return prisma.cron.create({
      data: { machineId: ctx.machine.id, ...input, nextFire: new Date() },
    });
  }),

  update: machineProcedure
    .input(z.object({ id: z.string() }).and(CronInput.partial()))
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const existing = await prisma.cron.findUnique({ where: { id } });
      if (!existing || existing.machineId !== ctx.machine.id) throw new Error('not found');
      // Changing the interval reschedules the next fire from the last run, so a
      // shorter interval runs sooner (and a longer one later) instead of waiting
      // out the old schedule. (A never-fired cron keeps its nextFire = now.)
      const data: Record<string, unknown> = { ...patch };
      if (patch.intervalSec != null && existing.lastFire) {
        data.nextFire = new Date(existing.lastFire.getTime() + patch.intervalSec * 1000);
      }
      return prisma.cron.update({ where: { id }, data });
    }),

  delete: machineProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const existing = await prisma.cron.findUnique({ where: { id: input.id } });
    if (!existing || existing.machineId !== ctx.machine.id) throw new Error('not found');
    await prisma.cron.delete({ where: { id: input.id } }); // CronRuns cascade
    return { ok: true };
  }),

  // Manual fire — set nextFire to NOW so the next gateway cron tick (≤15s) runs
  // it. (Was new Date(0): that epoch sentinel rendered as "1970/1/1" in the UI's
  // "下次" line for the ≤15s window before the gateway fires and recomputes
  // nextFire = now + interval. "now" is ≤ now so it still fires next tick, but
  // reads sensibly if shown — and the UI now labels a due nextFire "即将运行…".)
  runNow: machineProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const existing = await prisma.cron.findUnique({ where: { id: input.id } });
    if (!existing || existing.machineId !== ctx.machine.id) throw new Error('not found');
    await prisma.cron.update({ where: { id: input.id }, data: { nextFire: new Date() } });
    return { ok: true };
  }),

  // ── Skill-facing (agent calls mcp__hermit__cron_* mid-chat) ───────────────
  // The MCP stub knows only the chat sessionId; resolve agentName from it so a
  // skill-created cron lands on the right agent and shows on /cron like any other.
  createFromSession: machineProcedure
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
      return prisma.cron.create({
        data: {
          machineId: ctx.machine.id,
          agentName: session.agentName,
          prompt: input.prompt,
          intervalSec: input.intervalSec,
          jitterSec: input.jitterSec,
          title: input.title,
          nextFire: new Date(),
        },
      });
    }),

  listForSession: machineProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const session = await prisma.chatSession.findUnique({
        where: { id: input.sessionId },
        select: { agentName: true, machineId: true },
      });
      if (!session || session.machineId !== ctx.machine.id) return [];
      return prisma.cron.findMany({
        where: { machineId: ctx.machine.id, agentName: session.agentName },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, title: true, prompt: true, intervalSec: true,
          jitterSec: true, enabled: true, lastStatus: true, lastFire: true,
        },
      });
    }),

  deleteFromSession: machineProcedure
    .input(z.object({ sessionId: z.string(), id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const session = await prisma.chatSession.findUnique({
        where: { id: input.sessionId },
        select: { agentName: true, machineId: true },
      });
      if (!session || session.machineId !== ctx.machine.id) throw new Error('session not found');
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
  listForGateway: machineProcedure.query(async ({ ctx }) => {
    const crons = await prisma.cron.findMany({
      where: { machineId: ctx.machine.id, enabled: true },
    });
    const names = [...new Set(crons.map((c) => c.agentName))];
    const agents = names.length
      ? await prisma.agent.findMany({
          where: { machineId: ctx.machine.id, name: { in: names } },
          select: { name: true, directory: true, isOrchestrator: true },
        })
      : [];
    const dirByName = new Map(agents.map((a) => [a.name, a.directory]));
    const orchByName = new Map(agents.map((a) => [a.name, a.isOrchestrator]));
    return crons.map((c) => ({
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
    }));
  }),
});
