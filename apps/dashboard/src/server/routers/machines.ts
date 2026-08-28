import { z } from 'zod';
import { router, gatewayProcedure, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { invalidateMachineCache } from '../auth';
import { Prisma } from '@/generated/prisma/client';
import { CUSTOM_HARNESSES } from '@/lib/runtime-labels';
import { listBackends, backendsConfigOf } from '@/lib/backends';
import { watchdogConfigOf } from '@/lib/watchdog-config';
import { modelCredentialsOf, defaultModelOf } from '@/lib/model-credentials';
import { claudeModelsOf } from '@/lib/claude-models';

// ── Machine operations ────────────────────────────────────────────────────────
// The ops the dashboard can queue for a gateway to run on its host. Kept in step
// with the gateway's dispatch by hand (apps/gateway/src/machine-requests.ts): a
// kind no gateway on that machine knows is acked as `unknown kind`, which is the
// right failure but a puzzling one to read, so a machine whose gateway has not
// been updated yet answers the two gateway ops with exactly that.
const OPS_KINDS = ['upgrade-claude', 'restart-all-sessions', 'update-gateway', 'restart-gateway'];

// How long a `running` row keeps the button disabled. Re-queueing while an op is
// in flight collapses onto that row instead of stacking a second identical one —
// but the two gateway ops end by killing the process that would have resolved
// them, so an ack that loses its race would otherwise leave a row that blocks the
// button forever. `pending` is NOT aged out: that one means the gateway has not
// polled yet, and waiting is the correct behaviour there.
const OP_IN_FLIGHT_MS = 10 * 60_000;

// A `running` row this old is not work in progress — it is a gateway that died
// between claiming the op and reporting on it, which is a normal ending for the
// two ops that restart the gateway. Measured from the claim (startedAt) so a
// request that waited hours for an offline machine is not born stale; older
// rows have no claim stamp and fall back to when they were asked for.
function opIsStale(row: { status: string; startedAt: Date | null; requestedAt: Date }): boolean {
  return row.status === 'running' && (row.startedAt ?? row.requestedAt).getTime() < Date.now() - OP_IN_FLIGHT_MS;
}

function pendingRequest(machineId: string, kind: string) {
  const cutoff = new Date(Date.now() - OP_IN_FLIGHT_MS);
  return prisma.machineRequest.findFirst({
    where: {
      machineId,
      kind,
      OR: [
        { status: 'pending' },
        { status: 'running', startedAt: { gt: cutoff } },
        { status: 'running', startedAt: null, requestedAt: { gt: cutoff } },
      ],
    },
    select: { id: true },
  });
}

export const PI_CONFIG_SCHEMA = z.object({
  // NOTE: `authMode` used to live here and could name 'cc-subscription', which
  // pointed pi at this machine's Claude Code OAuth credentials. That option is
  // gone — running third-party harnesses against one Max account is the thing
  // rate limits and the request classifier exist to catch. A stored value is
  // simply ignored; the schema strips it on the next write.
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

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** One Settings → Models entry. Holds a secret NAME, never a secret value. */
export const MODEL_CREDENTIAL_SCHEMA = z.object({
  id: z.string().trim().regex(SLUG).max(48),
  label: z.string().trim().min(1).max(60),
  provider: z.string().trim().min(1).max(64),
  api: z.string().trim().min(1).max(48),
  // Blank is legal and meaningful: it marks a credential whose harness supplies
  // its own endpoint (dsh against DeepSeek's own catalog). A URL is validated
  // only when one is given, so a typo still cannot become a silent 404.
  baseUrl: z.union([z.literal(''), z.string().trim().url()]),
  models: z.array(z.string().trim().min(1).max(128)).max(50),
  defaultModel: z.string().trim().max(128).optional(),
  secretKey: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(64).optional().nullable(),
  modelLimits: z
    .record(
      z.string().trim().min(1),
      z.object({
        contextWindow: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});

/** One composed backend: a harness paired with a credential. */
export const BACKEND_INSTANCE_SCHEMA = z.object({
  id: z.string().trim().regex(SLUG).max(64),
  harness: z.enum(CUSTOM_HARNESSES),
  credentialId: z.string().trim().regex(SLUG).max(48),
  label: z.string().trim().min(1).max(60),
  model: z.string().trim().max(128).nullish(),
  mode: z.string().trim().max(64).nullish(),
});

export const BACKENDS_CONFIG_SCHEMA = z.object({
  disabled: z.array(z.string().max(64)).max(40),
  instances: z.array(BACKEND_INSTANCE_SCHEMA).max(20).optional(),
  // Read by the migration, never written again.
  dshSource: z.enum(['deepseek', 'pi-endpoint']).optional(),
});

// Settings → Watchdogs. Bounds mirror the clamps in lib/watchdog-config.ts.
export const WATCHDOG_CONFIG_SCHEMA = z.object({
  stuck: z.object({ enabled: z.boolean(), minutes: z.number().min(1).max(24 * 60) }),
  unanswered: z.object({ enabled: z.boolean(), minutes: z.number().min(1).max(24 * 60) }),
  hostRed: z.object({
    enabled: z.boolean(),
    redFreeMb: z.number().min(0).max(1_000_000),
    amberFreeMb: z.number().min(0).max(1_000_000),
    redLoadFactor: z.number().min(0.5).max(100),
    amberLoadFactor: z.number().min(0.1).max(100),
  }),
  strayReaper: z.object({
    enabled: z.boolean(),
    ageMinutes: z.number().min(5).max(7 * 24 * 60),
    maxRoots: z.number().min(1).max(1000),
  }),
  chromeReaper: z.object({ enabled: z.boolean(), idleMinutes: z.number().min(1).max(24 * 60) }),
  gatewayWatch: z.object({
    loadMax: z.number().min(1).max(10000),
    silentSec: z.number().min(60).max(86400),
    wedgeFails: z.number().min(10).max(100000),
    confirmSec: z.number().min(10).max(3600),
    cooldownSec: z.number().min(300).max(7 * 86400),
  }),
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

  // ── Settings → Models: the machine's model credentials ───────────────────
  //
  // Never returns a key VALUE — a credential holds the NAME of a secret in the
  // machine's own store, and that is all this endpoint has ever seen.
  getModelCredentials: machineProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
    return modelCredentialsOf(m);
  }),

  // Which models Claude Code offers on this machine — the CLI's own
  // `supportedModels()` answer, pushed by the gateway (/api/sync/claude-models)
  // and read by the chat header's model picker. Falls back to a small list when
  // no gateway has reported yet, so the picker is never empty on a fresh
  // machine. Nothing here is editable: the catalogue belongs to the CLI.
  getClaudeModels: machineProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({
      where: { id: ctx.machine.id },
      select: { claudeModels: true },
    });
    return claudeModelsOf(m);
  }),

  setModelCredentials: machineProcedure
    .input(z.object({ credentials: z.array(MODEL_CREDENTIAL_SCHEMA).max(30) }))
    .mutation(async ({ ctx, input }) => {
      const ids = input.credentials.map((c) => c.id);
      if (new Set(ids).size !== ids.length) throw new Error('Two credentials cannot share an id.');

      // A credential a backend is built on cannot be deleted out from under it:
      // the backend would keep resolving, spawn with no endpoint and no key, and
      // fail at the first turn with a 401 nobody could trace back to here.
      const backends = backendsConfigOf(await prisma.machine.findUnique({ where: { id: ctx.machine.id } }));
      const orphaned = listBackends(backends)
        .filter((b) => b.credentialId && !ids.includes(b.credentialId));
      if (orphaned.length > 0) {
        throw new Error(
          `Still in use by ${orphaned.map((b) => b.label).join(', ')}. `
          + 'Remove those backends first, or point them at another credential.',
        );
      }

      await prisma.machine.update({
        where: { id: ctx.machine.id },
        data: { modelProviders: input.credentials as unknown as Prisma.InputJsonValue },
      });
      invalidateMachineCache(ctx.machine.id);
      return { ok: true };
    }),

  // The vision fallback (used when an endpoint drops image blocks) still lives
  // on piConfig, because it is a machine-level pair of models and not a
  // credential a backend is built on. Merged rather than replaced so the legacy
  // endpoint fields survive for pollPiConfig's compatibility projection.
  setVisionConfig: machineProcedure
    .input(z.object({ image: PI_CONFIG_SCHEMA.shape.image }))
    .mutation(async ({ ctx, input }) => {
      const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
      const current = (m?.piConfig as Record<string, unknown> | null) ?? {};
      await prisma.machine.update({
        where: { id: ctx.machine.id },
        data: { piConfig: { ...current, image: input.image ?? undefined } as unknown as Prisma.InputJsonValue },
      });
      return { ok: true };
    }),

  // Read for the vision card and for the legacy endpoint fields the projection
  // below still needs. Reads fresh from the DB so the gateway's polling and the
  // browser see the same snapshot.
  getPiConfig: machineProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
    return (m?.piConfig as unknown as z.infer<typeof PI_CONFIG_SCHEMA> | null) ?? null;
  }),

  /**
   * Whether the two subscription backends are actually live on this machine.
   *
   * Derived from the usage collectors rather than probed: the Claude and Codex
   * collectors only produce a row when their CLI is installed, authenticated
   * and reporting, so a fresh `capturedAt` is the same evidence a probe would
   * gather, at no cost and with no new gateway round-trip. Absent means "the
   * collector has never seen it", which is what the page says — not "logged
   * out", which we would be guessing.
   */
  subscriptionStatus: machineProcedure.query(async ({ ctx }) => {
    const [claude, codex] = await Promise.all([
      prisma.planUsage.findUnique({ where: { machineId: ctx.machine.id }, select: { capturedAt: true } }),
      prisma.codexUsage.findUnique({ where: { machineId: ctx.machine.id }, select: { capturedAt: true, planType: true } }),
    ]);
    return {
      'claude-tmux': { seenAt: claude?.capturedAt ?? null, plan: null as string | null },
      'codex-exec': { seenAt: codex?.capturedAt ?? null, plan: codex?.planType ?? null },
    };
  }),

  // ── Settings → Backends ──────────────────────────────────────────────────
  //
  // Shape and defaulting rules live in lib/backends; this stores and returns
  // them, and refuses the two states the UI must never be able to reach.
  getBackendsConfig: machineProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
    return backendsConfigOf(m);
  }),

  // ── Watchdog config (Settings → Watchdogs) ───────────────────────────────
  //
  // Whole-object replace, same as setBackendsConfig. The UI sends the full six
  // sections; the zod schema is the only validation (lib/watchdog-config.ts
  // supplies defaults everywhere else, so a cleared column means "all default").
  getWatchdogConfig: machineProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
    return watchdogConfigOf(m);
  }),

  setWatchdogConfig: machineProcedure
    .input(z.object({ config: WATCHDOG_CONFIG_SCHEMA.nullable() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.machine.update({
        where: { id: ctx.machine.id },
        data: { watchdogConfig: (input.config ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue },
      });
      // The gateway polls this off the cached machine row; do not let a stale
      // cache sit on the old thresholds for up to the 5-minute auth TTL.
      invalidateMachineCache(ctx.machine.id);
      return { ok: true };
    }),

  /** Gateway-side read (Settings → Watchdogs), same shape as the browser getter. */
  pollWatchdogConfig: gatewayProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
    return watchdogConfigOf(m);
  }),

  setBackendsConfig: machineProcedure
    .input(z.object({ config: BACKENDS_CONFIG_SCHEMA.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const cfg = input.config;
      if (cfg) {
        const instances = cfg.instances ?? [];
        const ids = instances.map((i) => i.id);
        if (new Set(ids).size !== ids.length) throw new Error('Two backends cannot share an id.');
        if (ids.some((id) => id === 'claude-tmux' || id === 'codex-exec')) {
          throw new Error('That id belongs to a built-in backend.');
        }

        // Every composed backend must name a credential that exists. Checked
        // here rather than only in the form because this is a public procedure,
        // and a dangling reference fails invisibly at spawn time.
        const credentials = modelCredentialsOf(await prisma.machine.findUnique({ where: { id: ctx.machine.id } }));
        const known = new Set(credentials.map((c) => c.id));
        const missing = instances.filter((i) => !known.has(i.credentialId));
        if (missing.length > 0) {
          throw new Error(`Unknown credential: ${missing.map((i) => i.credentialId).join(', ')}`);
        }

        // The "never disable everything" rule is enforced in the UI against the
        // list it renders, but it is re-checked here: a machine with every
        // backend off would have a picker with nothing in it and no way to fix
        // itself from the app.
        const all = ['claude-tmux', 'codex-exec', ...ids];
        if (all.every((id) => cfg.disabled.includes(id))) {
          throw new Error('At least one backend has to stay enabled.');
        }
      }
      await prisma.machine.update({
        where: { id: ctx.machine.id },
        data: { backendsConfig: (cfg ?? Prisma.DbNull) as unknown as Prisma.InputJsonValue },
      });
      // The runtime resolver reads this off the CACHED machine row (it runs on
      // the gateway's 2s poll, so it cannot afford its own query). Without this,
      // switching a backend off left inherited sessions resolving to it for up
      // to the 5-minute auth TTL.
      invalidateMachineCache(ctx.machine.id);
      return { ok: true };
    }),

  // ── Gateway-side reads ───────────────────────────────────────────────────
  //
  // Separate from the browser getters so those are free to change shape without
  // breaking a gateway that has not been restarted.

  /** Everything a current gateway needs to spawn a session: catalog + backends. */
  pollRuntimeConfig: gatewayProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
    return { credentials: modelCredentialsOf(m), backends: backendsConfigOf(m) };
  }),

  pollBackendsConfig: gatewayProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
    return backendsConfigOf(m);
  }),

  /**
   * Compatibility projection for a gateway that has not restarted yet.
   *
   * The fleet's minis run a lagging gateway for days after a dashboard deploy,
   * and that gateway asks for one endpoint in the old shape. It gets the
   * credential its first pi backend is built on — the same endpoint it was
   * already running — with the vision block carried through untouched. A
   * machine with no pi backend falls back to the first credential it has, and
   * to the stored legacy fields if it has none.
   */
  pollPiConfig: gatewayProcedure.query(async ({ ctx }) => {
    const m = await prisma.machine.findUnique({ where: { id: ctx.machine.id } });
    const legacy = (m?.piConfig as Record<string, unknown> | null) ?? null;
    const credentials = modelCredentialsOf(m);
    const piBackend = listBackends(backendsConfigOf(m)).find((b) => b.harness === 'pi-rpc');
    const chosen =
      credentials.find((c) => c.id === piBackend?.credentialId) ?? credentials[0] ?? null;
    if (!chosen) return legacy;
    return {
      ...(legacy ?? {}),
      provider: chosen.provider,
      baseUrl: chosen.baseUrl,
      api: chosen.api,
      models: chosen.models,
      defaultModel: piBackend?.model ?? defaultModelOf(chosen) ?? undefined,
      secretKey: chosen.secretKey ?? null,
      ...(chosen.modelLimits ? { modelLimits: chosen.modelLimits } : {}),
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
    const existing = await pendingRequest(ctx.machine.id, 'upgrade-claude');
    if (existing) return { ok: true, id: existing.id, alreadyQueued: true };
    const r = await prisma.machineRequest.create({
      data: { machineId: ctx.machine.id, kind: 'upgrade-claude' },
      select: { id: true },
    });
    return { ok: true, id: r.id, alreadyQueued: false };
  }),

  requestRestartAllSessions: machineProcedure.mutation(async ({ ctx }) => {
    const existing = await pendingRequest(ctx.machine.id, 'restart-all-sessions');
    if (existing) return { ok: true, id: existing.id, alreadyQueued: true };
    const r = await prisma.machineRequest.create({
      data: { machineId: ctx.machine.id, kind: 'restart-all-sessions' },
      select: { id: true },
    });
    return { ok: true, id: r.id, alreadyQueued: false };
  }),

  // Pull this machine's gateway checkout up to origin and restart it onto the
  // new code (Settings → System). A no-op pull never restarts — see the
  // gateway's runUpdateGateway.
  requestUpdateGateway: machineProcedure.mutation(async ({ ctx }) => {
    const existing = await pendingRequest(ctx.machine.id, 'update-gateway');
    if (existing) return { ok: true, id: existing.id, alreadyQueued: true };
    const r = await prisma.machineRequest.create({
      data: { machineId: ctx.machine.id, kind: 'update-gateway' },
      select: { id: true },
    });
    return { ok: true, id: r.id, alreadyQueued: false };
  }),

  requestRestartGateway: machineProcedure.mutation(async ({ ctx }) => {
    const existing = await pendingRequest(ctx.machine.id, 'restart-gateway');
    if (existing) return { ok: true, id: existing.id, alreadyQueued: true };
    const r = await prisma.machineRequest.create({
      data: { machineId: ctx.machine.id, kind: 'restart-gateway' },
      select: { id: true },
    });
    return { ok: true, id: r.id, alreadyQueued: false };
  }),

  // Latest request per kind — drives the panel's status/output. Polled while a
  // request is in flight so "running…" → "done" updates without a refresh.
  opsStatus: machineProcedure.query(async ({ ctx }) => {
    // One query per kind rather than one capped query across all of them: with
    // N newest rows overall, a kind that was run twenty times in a row hides
    // every other kind's last result, and the panel then shows no result for an
    // op that is genuinely running.
    const [upgrade, restartAll, updateGateway, restartGateway] = await Promise.all(
      OPS_KINDS.map((kind) =>
        prisma.machineRequest.findFirst({
          where: { machineId: ctx.machine.id, kind },
          orderBy: { requestedAt: 'desc' },
          select: { id: true, kind: true, status: true, output: true, error: true, requestedAt: true, startedAt: true, resolvedAt: true },
        }),
      ),
    );
    // `stale` travels with the row so the buttons disable on exactly the rule
    // the mutations refuse on — a client deciding for itself would go on
    // spinning over a row the server would happily accept a replacement for.
    // Spread inline rather than through a generic helper: a `<T extends {...}>`
    // wrapper collapses T to its constraint here, and every field the panels
    // render (output, error, resolvedAt) silently drops off the client's type.
    return {
      upgrade: upgrade && { ...upgrade, stale: opIsStale(upgrade) },
      restartAll: restartAll && { ...restartAll, stale: opIsStale(restartAll) },
      updateGateway: updateGateway && { ...updateGateway, stale: opIsStale(updateGateway) },
      restartGateway: restartGateway && { ...restartGateway, stale: opIsStale(restartGateway) },
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
          // The claim stamp, written here rather than by the gateway so an
          // older gateway's ack sets it too.
          ...(input.status === 'running' ? { startedAt: new Date() } : {}),
          ...(input.status === 'done' || input.status === 'error' ? { resolvedAt: new Date() } : {}),
        },
      });
      return { ok: true };
    }),
});
