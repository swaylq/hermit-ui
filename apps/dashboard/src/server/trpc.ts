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

// Agent-scoped: accepts machine keys (full access) AND scoped share tokens, but a
// scoped caller may only touch ITS agent. Resolvers call `ctx.assertAgent(name)`
// once the target agent is known (a no-op for machine keys; FORBIDDEN for a
// scoped key targeting a different agent), or constrain queries by
// `ctx.scopedAgent`. Forgetting the check on an id/session-keyed endpoint would
// let a scoped key reach sibling agents, so every converted resolver asserts.
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
