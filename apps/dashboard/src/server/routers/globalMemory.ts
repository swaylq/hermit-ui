// Global memory — a PER-MACHINE shared note loaded by every agent on that host.
// All procedures are scoped to ctx.machine.id (resolved from the x-asst-key), so:
//   · the dashboard editor reads/writes the ACTIVE machine's note (its key), and
//   · each gateway pulls ITS OWN machine's note (its key) to mirror into
//     ~/.claude/CLAUDE.md.
// No cross-machine sharing — one row per machine.

import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

const MAX = 200_000; // generous ceiling for one shared note

export const globalMemoryRouter = router({
  // This machine's content + enabled flag (defaults: empty + on). Read by the
  // editor + the gateway. `enabled` false → the gateway drops the CLAUDE.md block.
  get: machineProcedure.query(async ({ ctx }) => {
    const row = await prisma.globalMemory.findUnique({ where: { machineId: ctx.machine.id } });
    return { content: row?.content ?? '', enabled: row?.enabled ?? true, updatedAt: row?.updatedAt ?? null };
  }),

  // Upsert this machine's content. Dashboard editor save.
  set: machineProcedure
    .input(z.object({ content: z.string().max(MAX) }))
    .mutation(async ({ ctx, input }) => {
      return prisma.globalMemory.upsert({
        where: { machineId: ctx.machine.id },
        create: { machineId: ctx.machine.id, content: input.content },
        update: { content: input.content },
        select: { content: true, enabled: true, updatedAt: true },
      });
    }),

  // Toggle whether this machine's agents load it. Content is preserved either way.
  setEnabled: machineProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return prisma.globalMemory.upsert({
        where: { machineId: ctx.machine.id },
        create: { machineId: ctx.machine.id, enabled: input.enabled },
        update: { enabled: input.enabled },
        select: { content: true, enabled: true, updatedAt: true },
      });
    }),
});
