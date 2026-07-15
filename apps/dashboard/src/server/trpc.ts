import { initTRPC, TRPCError } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import { resolveKey } from './auth';

export async function createContext({ req }: FetchCreateContextFnOptions) {
  const key = req.headers.get('x-asst-key') ?? '';
  return { keyPlain: key };
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Resolve the X-Asst-Key into a scope: a Machine (full access) or an
// AgentShareLink (scoped to one agent). Auth (prefix-filtered bcrypt + a shared
// process-local cache) lives in ./auth, so the /api/sync/* gateway-write routes
// reuse the exact same resolver + cache. Injects { machine, scope, scopedAgent }.
const withScope = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.keyPlain) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'missing X-Asst-Key' });
  const resolved = await resolveKey(ctx.keyPlain);
  if (!resolved) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid key' });
  return next({
    ctx: { ...ctx, machine: resolved.machine, scope: resolved.scope, scopedAgent: resolved.scopedAgent },
  });
});

// Any valid key (machine OR scoped share token), with no agent restriction. Use
// ONLY for endpoints that are safe for a scoped caller and not agent-specific
// (e.g. share.whoami). Everything data-bearing should use machine/agentProcedure.
export const authedProcedure = withScope;

// Full-access: REJECTS scoped share keys. Because every existing router already
// uses machineProcedure, this one change makes the whole ~190-endpoint surface
// deny share tokens by default — a scoped key can't reach machines / brain /
// market / global-memory / secrets / the agent list / gateway-poll endpoints.
// Keeps the same `ctx.machine` shape those call sites already read.
export const machineProcedure = withScope.use(async ({ ctx, next }) => {
  if (ctx.scope === 'agent')
    throw new TRPCError({ code: 'FORBIDDEN', message: 'this share link is scoped to a single agent' });
  return next({ ctx });
});

// Machine-wide GATEWAY plumbing: the poll* / ack* / *ForGateway endpoints a
// machine's gateway calls (never the browser) to drain its request queues and push
// runtime state. Enforcement is IDENTICAL to machineProcedure (rejects scoped share
// keys, ctx.machine intact) — this is a NAMED alias so "gateway plumbing" reads
// distinctly from a browser-facing full-access endpoint, and gives one seam to add
// gateway-only policy later. NOT for browser-driven machine actions (e.g. the bulk-
// reap panel's reapIdleNow, or hosts.ackAlert) — those stay machineProcedure.
export const gatewayProcedure = machineProcedure;

// Agent-scoped: accepts machine keys (full access) AND scoped share tokens, but a
// scoped caller may only touch ITS agent. An id/session-keyed endpoint that forgets
// to scope would let a scoped key reach SIBLING agents (it compiles + passes review),
// so EVERY agentProcedure resolver MUST scope by exactly one of these patterns:
//   1. a top-level `agentName`/`name` input field   → auto-asserted below (free);
//   2. `ctx.assertAgent(loadedName)` after loading a row keyed by id/session/cron
//      (a no-op for machine keys; FORBIDDEN for a scoped key targeting another agent);
//   3. a `ctx.scopedAgent`-constrained WHERE (findFirst/updateMany then returns nothing
//      cross-agent), or a helper that does the same (fileManager's fsTarget()).
// This invariant is enforced by a static-scan regression test
// (apps/gateway/src/tenancy.test.ts) so a future id-keyed endpoint can't silently ship
// unscoped — the failure the audit found in fileManager.downloadStatus (now fixed).
export const agentProcedure = withScope.use(async ({ ctx, getRawInput, next }) => {
  const assertAgent = (agentName: string | null | undefined) => {
    if (ctx.scopedAgent && agentName !== ctx.scopedAgent)
      throw new TRPCError({ code: 'FORBIDDEN', message: 'outside the shared agent' });
  };
  // Scoped keys: auto-assert on a top-level `agentName`/`name` input field so the
  // many name-keyed endpoints (agents.*, createSession, cron.listForAgent, …) are
  // covered with no per-resolver edit. Endpoints keyed by a session/cron id carry
  // no such field — those MUST call ctx.assertAgent(loadedName) themselves. Fail
  // CLOSED: if a scoped call's input can't be read, refuse rather than risk a leak.
  if (ctx.scopedAgent) {
    let raw: unknown;
    try {
      raw = await getRawInput();
    } catch {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'cannot scope this request' });
    }
    if (raw && typeof raw === 'object') {
      const named = (raw as Record<string, unknown>).agentName ?? (raw as Record<string, unknown>).name;
      if (typeof named === 'string') assertAgent(named);
    }
  }
  return next({ ctx: { ...ctx, assertAgent } });
});
