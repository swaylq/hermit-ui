// Global memory — a single shared note loaded by every agent. The dashboard
// (Settings → Global Memory) reads/writes it here; each machine's gateway pulls
// `get` and keeps it in that host's ~/.claude/CLAUDE.md so Claude Code injects it
// into every session. Singleton: the row id is always "global".

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

const ID = 'global';
const MAX = 200_000; // generous ceiling for one shared note

export const globalMemoryRouter = router({
  // Current content (empty string if never set). Read by the editor + the gateway.
  get: machineProcedure.query(async () => {
    const row = await prisma.globalMemory.findUnique({ where: { id: ID } });
    return { content: row?.content ?? '', updatedAt: row?.updatedAt ?? null };
  }),

  // Upsert the singleton. Dashboard editor save.
  set: machineProcedure
    .input(z.object({ content: z.string().max(MAX) }))
    .mutation(async ({ input }) => {
      const row = await prisma.globalMemory.upsert({
        where: { id: ID },
        create: { id: ID, content: input.content },
        update: { content: input.content },
        select: { content: true, updatedAt: true },
      });
      return row;
    }),
});
