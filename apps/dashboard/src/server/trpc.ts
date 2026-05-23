import { initTRPC, TRPCError } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import bcrypt from 'bcryptjs';
import { prisma } from './db';

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

// Protected: requires a valid machine key in X-Asst-Key header.
export const machineProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.keyPlain) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'missing X-Asst-Key' });

  // Compare against every Machine.keyHash. For a small N (one machine for now,
  // small even at multi-host scale) this is fine. Indexing keyPrefix helps if N grows.
  const prefix = ctx.keyPlain.slice(0, 8);
  const candidates = await prisma.machine.findMany({ where: { keyPrefix: prefix } });

  let machine: (typeof candidates)[number] | null = null;
  for (const m of candidates) {
    if (await bcrypt.compare(ctx.keyPlain, m.keyHash)) {
      machine = m;
      break;
    }
  }
  if (!machine) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid key' });

  await prisma.machine.update({ where: { id: machine.id }, data: { lastSeen: new Date() } });
  return next({ ctx: { ...ctx, machine } });
});
