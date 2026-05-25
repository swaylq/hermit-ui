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

// ── Auth cache ───────────────────────────────────────────────────────────────
//
// `bcrypt.compare` is intentionally CPU-bound (~50-200ms per call). Without
// caching, every tRPC query on every page mount triggers a fresh compare PLUS
// a findMany + UPDATE — and the chat page fires 4 parallel queries on load
// that each loop bcrypt over candidate hashes. That's the bulk of chat-page
// load lag.
//
// We cache the resolved Machine by plaintext key for `AUTH_TTL_MS`. Cache is
// process-local; pm2 cluster mode warms independently per worker (fine).
// `lastSeen` writes are debounced by `LASTSEEN_DEBOUNCE_MS` so a tight 600ms
// message-poll doesn't slam UPDATE every tick.

type MachineRow = Awaited<ReturnType<typeof prisma.machine.findMany>>[number];

interface AuthCacheEntry {
  machine: MachineRow;
  cachedAt: number;
  lastSeenBumpedAt: number;
}

const AUTH_TTL_MS = 5 * 60_000;
const LASTSEEN_DEBOUNCE_MS = 30_000;
const authCache = new Map<string, AuthCacheEntry>();

function getCached(key: string): AuthCacheEntry | null {
  const hit = authCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > AUTH_TTL_MS) {
    authCache.delete(key);
    return null;
  }
  return hit;
}

async function resolveMachineUncached(keyPlain: string): Promise<MachineRow | null> {
  const prefix = keyPlain.slice(0, 8);
  const candidates = await prisma.machine.findMany({ where: { keyPrefix: prefix } });
  for (const m of candidates) {
    if (await bcrypt.compare(keyPlain, m.keyHash)) return m;
  }
  return null;
}

// Protected: requires a valid machine key in X-Asst-Key header.
export const machineProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.keyPlain) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'missing X-Asst-Key' });

  let hit = getCached(ctx.keyPlain);
  if (!hit) {
    const machine = await resolveMachineUncached(ctx.keyPlain);
    if (!machine) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid key' });
    hit = { machine, cachedAt: Date.now(), lastSeenBumpedAt: 0 };
    authCache.set(ctx.keyPlain, hit);
  }

  // Debounced lastSeen bump — fire-and-forget so it doesn't block the response.
  if (Date.now() - hit.lastSeenBumpedAt > LASTSEEN_DEBOUNCE_MS) {
    hit.lastSeenBumpedAt = Date.now();
    void prisma.machine.update({ where: { id: hit.machine.id }, data: { lastSeen: new Date() } });
  }

  return next({ ctx: { ...ctx, machine: hit.machine } });
});
