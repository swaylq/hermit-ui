import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { invalidateMachineCache } from '../auth';

export const machinesRouter = router({
  me: machineProcedure.query(async ({ ctx }) => {
    // Read fresh, NOT the cached auth snapshot — so alias / limits reflect the
    // latest write immediately, even across pm2 cluster workers (each warms its
    // own auth cache, so a setAlias on one worker won't bust another's). me is
    // not the hot path (the chat poll is), so this extra PK lookup is cheap; the
    // expensive bcrypt auth stays cached upstream in resolveMachineByKey.
    const m = (await prisma.machine.findUnique({ where: { id: ctx.machine.id } })) ?? ctx.machine;
    return {
      id: m.id,
      name: m.name,
      alias: m.alias,
      hostname: m.hostname,
      keyPrefix: m.keyPrefix,
      createdAt: m.createdAt,
      lastSeen: m.lastSeen,
      fiveHourLimitUsd: m.fiveHourLimitUsd,
      weeklyLimitUsd: m.weeklyLimitUsd,
    };
  }),

  setLimits: machineProcedure
    .input(
      z.object({
        fiveHourLimitUsd: z.number().nullable().optional(),
        weeklyLimitUsd: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return prisma.machine.update({
        where: { id: ctx.machine.id },
        data: {
          ...(input.fiveHourLimitUsd !== undefined ? { fiveHourLimitUsd: input.fiveHourLimitUsd } : {}),
          ...(input.weeklyLimitUsd !== undefined ? { weeklyLimitUsd: input.weeklyLimitUsd } : {}),
        },
        select: { fiveHourLimitUsd: true, weeklyLimitUsd: true },
      });
    }),

  // Server-side display alias for this machine — shown in the dashboard's
  // workspace switcher (falls back to `name` when null). Blank clears it.
  setAlias: machineProcedure
    .input(z.object({ alias: z.string().trim().max(40).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const alias = input.alias && input.alias.length > 0 ? input.alias : null;
      await prisma.machine.update({ where: { id: ctx.machine.id }, data: { alias } });
      invalidateMachineCache(ctx.machine.id); // else machines.me serves the stale cached alias for ≤5 min
      return { alias };
    }),

  // ── Operations panel ────────────────────────────────────────────────────────
  // Machine-level ops the gateway runs on its host. The dashboard can't touch the
  // host, so it queues a MachineRequest; the gateway polls, executes, writes the
  // result back. Re-queuing while one is pending/running collapses to the same row.
  requestUpgradeClaude: machineProcedure.mutation(async ({ ctx }) => {
    const existing = await prisma.machineRequest.findFirst({
      where: { machineId: ctx.machine.id, kind: 'upgrade-claude', status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    if (existing) return { ok: true, id: existing.id, alreadyQueued: true };
    const r = await prisma.machineRequest.create({
      data: { machineId: ctx.machine.id, kind: 'upgrade-claude' },
      select: { id: true },
    });
    return { ok: true, id: r.id, alreadyQueued: false };
  }),

  requestRestartAllSessions: machineProcedure.mutation(async ({ ctx }) => {
    const existing = await prisma.machineRequest.findFirst({
      where: { machineId: ctx.machine.id, kind: 'restart-all-sessions', status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    if (existing) return { ok: true, id: existing.id, alreadyQueued: true };
    const r = await prisma.machineRequest.create({
      data: { machineId: ctx.machine.id, kind: 'restart-all-sessions' },
      select: { id: true },
    });
    return { ok: true, id: r.id, alreadyQueued: false };
  }),

  // Latest request per kind — drives the panel's status/output. Polled while a
  // request is in flight so "running…" → "done" updates without a refresh.
  opsStatus: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.machineRequest.findMany({
      where: { machineId: ctx.machine.id, kind: { in: ['upgrade-claude', 'restart-all-sessions'] } },
      orderBy: { requestedAt: 'desc' },
      take: 10,
      select: { id: true, kind: true, status: true, output: true, error: true, requestedAt: true, resolvedAt: true },
    });
    return {
      upgrade: rows.find((r) => r.kind === 'upgrade-claude') ?? null,
      restartAll: rows.find((r) => r.kind === 'restart-all-sessions') ?? null,
    };
  }),

  // ── Claude account login (Settings → 登录 Claude Code 账号) ──────────────────
  // Queue a request for the gateway to (re)authenticate THIS machine's Claude
  // Code onto the given account via headed Chrome + `claude auth login`. Input is
  // already sanitized client-side (the `sk` is dropped); it lands in `payload`,
  // which the gateway NULLs the instant it claims the row. Collapses while one is
  // in flight so a double-tap doesn't queue two logins.
  requestLoginClaude: machineProcedure
    .input(
      z.object({
        email: z.string().trim().min(1).max(200),
        mailToken: z.string().trim().min(1).max(200),
        emailPassword: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.machineRequest.findFirst({
        where: {
          machineId: ctx.machine.id,
          kind: 'login-claude-account',
          status: { in: ['pending', 'running', 'needs-human'] },
        },
        select: { id: true },
      });
      if (existing) return { ok: true, id: existing.id, alreadyQueued: true };
      const r = await prisma.machineRequest.create({
        data: {
          machineId: ctx.machine.id,
          kind: 'login-claude-account',
          payload: JSON.stringify({
            email: input.email,
            mailToken: input.mailToken,
            ...(input.emailPassword ? { emailPassword: input.emailPassword } : {}),
          }),
        },
        select: { id: true },
      });
      return { ok: true, id: r.id, alreadyQueued: false };
    }),

  // Latest login attempt for this machine — drives the page's live status +
  // needs-human banner. NEVER returns `payload`.
  loginStatus: machineProcedure.query(async ({ ctx }) => {
    return prisma.machineRequest.findFirst({
      where: { machineId: ctx.machine.id, kind: 'login-claude-account' },
      orderBy: { requestedAt: 'desc' },
      select: { id: true, status: true, output: true, error: true, requestedAt: true, resolvedAt: true },
    });
  }),

  // Manual reset for a stuck login: mark the in-flight attempt resolved so the UI
  // unblocks right away. The gateway's login-cancel tick notices this and aborts
  // the running orchestrator (closes Chrome, frees it for a fresh attempt).
  resetLogin: machineProcedure.mutation(async ({ ctx }) => {
    const row = await prisma.machineRequest.findFirst({
      where: {
        machineId: ctx.machine.id,
        kind: 'login-claude-account',
        status: { in: ['pending', 'running', 'needs-human'] },
      },
      orderBy: { requestedAt: 'desc' },
      select: { id: true },
    });
    if (!row) return { ok: true, reset: false };
    await prisma.machineRequest.update({
      where: { id: row.id },
      data: { status: 'error', error: '已手动重置', payload: null, resolvedAt: new Date() },
    });
    return { ok: true, reset: true };
  }),

  // ── Gateway endpoints ───────────────────────────────────────────────────────
  pollRequests: machineProcedure.query(async ({ ctx }) => {
    return prisma.machineRequest.findMany({
      where: { machineId: ctx.machine.id, status: 'pending' },
      orderBy: { requestedAt: 'asc' },
      select: { id: true, kind: true },
    });
  }),

  ackRequest: machineProcedure
    .input(
      z.object({
        id: z.string(),
        status: z.enum(['running', 'needs-human', 'done', 'error']),
        output: z.string().optional(),
        error: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await prisma.machineRequest.updateMany({
        where: { id: input.id, machineId: ctx.machine.id },
        data: {
          status: input.status,
          ...(input.output !== undefined ? { output: input.output.slice(0, 8000) } : {}),
          ...(input.error !== undefined ? { error: input.error.slice(0, 2000) } : {}),
          ...(input.status === 'done' || input.status === 'error' ? { resolvedAt: new Date() } : {}),
        },
      });
      return { ok: true };
    }),

  // Gateway: read the sanitized account payload for a login request and wipe it
  // in the same call (read-once). Scoped to the caller's machine. Returns null
  // when there's nothing to claim (already wiped / wrong machine / not a login).
  claimLoginPayload: machineProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const row = await prisma.machineRequest.findFirst({
        where: { id: input.id, machineId: ctx.machine.id, kind: 'login-claude-account' },
        select: { payload: true },
      });
      if (!row?.payload) return null;
      await prisma.machineRequest.updateMany({
        where: { id: input.id, machineId: ctx.machine.id },
        data: { payload: null },
      });
      try {
        const p = JSON.parse(row.payload) as { email?: string; mailToken?: string; emailPassword?: string };
        if (!p.email || !p.mailToken) return null;
        return { email: p.email, mailToken: p.mailToken, emailPassword: p.emailPassword ?? null };
      } catch {
        return null;
      }
    }),
});
