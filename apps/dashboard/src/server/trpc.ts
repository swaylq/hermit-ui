import { initTRPC, TRPCError } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import { resolveMachineByKey } from './auth';

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

// Protected: requires a valid machine key in X-Asst-Key header. Auth
// (prefix-filtered bcrypt + a shared process-local cache) lives in ./auth, so
// the /api/sync/* gateway-write routes reuse the exact same resolver + cache —
// a gateway sync and a browser query no longer each re-bcrypt on the hot path.
export const machineProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.keyPlain) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'missing X-Asst-Key' });
  const machine = await resolveMachineByKey(ctx.keyPlain);
  if (!machine) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid key' });
  return next({ ctx: { ...ctx, machine } });
});
