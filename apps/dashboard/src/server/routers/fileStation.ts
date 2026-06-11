import { z } from 'zod';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:os';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

// Where the dashboard stashes uploaded files (mirrors the upload/download routes).
function fileStationDir(): string {
  const root = process.env.HERMIT_UPLOAD_DIR || (platform() === 'linux' ? '/var/hermit-ui/uploads' : '/tmp/hermit-ui/uploads');
  return join(root, 'file-station');
}
const dropTemp = (id: string) => unlink(join(fileStationDir(), `${id}.bin`)).catch(() => {});

export const fileStationRouter = router({
  // UI: recent transfers for the active machine (drives the status list).
  list: machineProcedure.query(async ({ ctx }) => {
    return prisma.fileTransfer.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: { requestedAt: 'desc' },
      take: 12,
      select: {
        id: true,
        filename: true,
        destPath: true,
        size: true,
        unzip: true,
        status: true,
        error: true,
        requestedAt: true,
        resolvedAt: true,
      },
    });
  }),

  // UI: drop a transfer row (+ any leftover stashed bytes).
  remove: machineProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await prisma.fileTransfer.deleteMany({ where: { id: input.id, machineId: ctx.machine.id } });
    await dropTemp(input.id);
    return { ok: true };
  }),

  // ── Gateway endpoints ───────────────────────────────────────────────────────
  pollPending: machineProcedure.query(async ({ ctx }) => {
    return prisma.fileTransfer.findMany({
      where: { machineId: ctx.machine.id, status: 'pending' },
      orderBy: { requestedAt: 'asc' },
      select: { id: true, filename: true, destPath: true, size: true, unzip: true },
    });
  }),

  ack: machineProcedure
    .input(z.object({ id: z.string(), status: z.enum(['running', 'done', 'error']), error: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const resolved = input.status === 'done' || input.status === 'error';
      await prisma.fileTransfer.updateMany({
        where: { id: input.id, machineId: ctx.machine.id },
        data: {
          status: input.status,
          ...(input.error !== undefined ? { error: input.error.slice(0, 2000) } : {}),
          ...(resolved ? { resolvedAt: new Date() } : {}),
        },
      });
      if (resolved) await dropTemp(input.id); // the bytes are on the machine now (or failed) — reclaim disk
      return { ok: true };
    }),
});
