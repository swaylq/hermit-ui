import { z } from 'zod';
import { router, gatewayProcedure, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { invalidateMachineCache } from '../auth';
import { Prisma } from '@/generated/prisma/client';
import { BACKEND_OPTIONS } from '@/lib/runtime-labels';

export const PI_CONFIG_SCHEMA = z.object({
  // 'api-key' (default): provider + secretKey as below; 'cc-subscription': reuse
  // this machine's Claude Code Keychain OAuth credentials instead of an API key.
  authMode: z.enum(['api-key', 'cc-subscription']).optional(),
  // hyqubit (or any Anthropic-compatible endpoint) base config
  provider: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().url().optional(),
  api: z.string().trim().optional(), // 'anthropic-messages' | 'openai' | ...
  models: z.array(z.string().trim().min(1)).optional(),
  // Escape hatch for a model the gateway's own limits table does not know
  // (apps/gateway/src/pi-model-limits.ts). Known families need no entry: the
  // generated pi/omp model config already declares their real window, which is
  // what stops the engine guessing 128k and truncating long conversations
  // mid-sentence. Schemas strip what they do not name, so this has to be here
  // for a stored override to survive a settings save at all.
  modelLimits: z
    .record(
      z.string().trim().min(1),
      z.object({
        contextWindow: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  // Which of them a new pi session gets when neither the session nor its agent
  // pins one. Without this the model had to be typed into the new-chat picker
  // every time, or left blank and decided by pi. Blank falls back to the first
  // entry of `models`.
  defaultModel: z.string().trim().optional(),
  // Name of the secret in the machine's encrypted store that holds the API key
  // (e.g. LITELLM_HYQUBIT_TOKEN). Never stores the value itself.
  secretKey: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).optional().nullable(),
  // image recognition (vision fallback for models whose endpoint drops images)
  image: z
    .object({
      enabled: z.boolean().optional(),
      provider: z.enum(['dashscope', 'openrouter', 'none']).optional(),
      apiKeySecret: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).optional().nullable(),
      ocrModel: z.string().trim().optional(),
      describeModel: z.string().trim().optional(),
      prompt: z.string().trim().max(2000).optional(),
    })
    .optional(),
});

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

  // Pi-runtime machine config (hyqubit endpoint + image recognition). Reads
  // fresh from the DB so the gateway's polling and the browser see the same
  // snapshot; never returns the API key value, only the secret name.
  getPiConfig: machineProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
    return (m?.piConfig as unknown as z.infer<typeof PI_CONFIG_SCHEMA> | null) ?? null;
  }),

  setPiConfig: machineProcedure
    .input(z.object({ config: PI_CONFIG_SCHEMA.nullable() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.machine.update({
        where: { id: ctx.machine.id },
        data: { piConfig: (input.config ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue },
      });
      return { ok: true };
    }),

  // Settings → Backends. Shape and defaulting rules live in
  // lib/backend-availability; this only stores and returns them.
  getBackendsConfig: machineProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
    return (m?.backendsConfig as unknown as { disabled: string[] } | null) ?? null;
  }),

  setBackendsConfig: machineProcedure
    .input(z.object({ config: z.object({ disabled: z.array(z.string().max(64)).max(20) }).nullable() }))
    .mutation(async ({ ctx, input }) => {
      // The "never disable everything" rule is enforced in the UI against the
      // option list it renders, but it is re-checked here because this is a
      // public procedure: a machine with every backend off would have a picker
      // with nothing in it and no way to fix itself from the app.
      if (input.config && input.config.disabled.length >= BACKEND_OPTIONS.length) {
        throw new Error('At least one backend has to stay enabled.');
      }
      await prisma.machine.update({
        where: { id: ctx.machine.id },
        data: { backendsConfig: (input.config ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue },
      });
      // The runtime resolver reads this set off the CACHED machine row (it runs
      // on the gateway's 2s poll, so it cannot afford its own query). Without
      // this, switching a backend off left inherited sessions resolving to it
      // for up to the 5-minute auth TTL.
      invalidateMachineCache(ctx.machine.id);
      return { ok: true };
    }),

  // Gateway-side read: same shape as getPiConfig but behind gatewayProcedure,
  // so a gateway polls it with its machine key without going through the
  // browser-scoped getter. Kept separate so getPiConfig can change shape for
  // the UI (e.g. add a mask) without breaking the gateway contract.
  pollPiConfig: gatewayProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
    return (m?.piConfig as unknown as z.infer<typeof PI_CONFIG_SCHEMA> | null) ?? null;
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

  // ── Gateway endpoints ───────────────────────────────────────────────────────
  pollRequests: gatewayProcedure.query(async ({ ctx }) => {
    return prisma.machineRequest.findMany({
      where: { machineId: ctx.machine.id, status: 'pending' },
      orderBy: { requestedAt: 'asc' },
      select: { id: true, kind: true },
    });
  }),

  ackRequest: gatewayProcedure
    .input(
      z.object({
        id: z.string(),
        status: z.enum(['running', 'done', 'error']),
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
});
