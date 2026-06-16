// Per-agent file manager. Interactive metadata ops (list / readText / mkdir /
// remove / rename) are forwarded LIVE to the agent's gateway over the control-
// channel bridge (gateway-bridge.ts → fs.req/fs.res) so the browser feels
// instant. Bulk download is prepared by the gateway and streamed up to the
// dashboard stash (/api/file-manager/ingest); the browser then pulls it from
// /api/file-manager/download/<id>. Upload reuses the existing File Station path.

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { requestFs, createDownload, getDownload } from '../gateway-bridge';

// Resolve the agent's absolute on-disk directory (the gateway scopes every fs op
// under it). DB is the leader for directories (Agent.directory).
async function agentDir(machineId: string, agentName: string): Promise<string> {
  const a = await prisma.agent.findFirst({
    where: { machineId, name: agentName },
    select: { directory: true },
  });
  if (!a?.directory) throw new Error('agent 目录未知（可能尚未被网关扫描到）');
  return a.directory;
}

type ListData = { entries: Array<{ name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number }>; truncated: boolean };

const PathInput = z.object({ agentName: z.string().min(1), path: z.string().default('') });

export const fileManagerRouter = router({
  // Directory listing — folders first, capped (the gateway truncates huge dirs).
  list: machineProcedure.input(PathInput).query(async ({ ctx, input }) => {
    const dir = await agentDir(ctx.machine.id, input.agentName);
    const res = await requestFs(ctx.machine.id, 'list', { agentDir: dir, relPath: input.path });
    if (!res.ok) throw new Error(res.error);
    return res.data as ListData;
  }),

  // Text preview of a single file (gateway rejects binary / >256 KB).
  readText: machineProcedure.input(PathInput).query(async ({ ctx, input }) => {
    const dir = await agentDir(ctx.machine.id, input.agentName);
    const res = await requestFs(ctx.machine.id, 'readText', { agentDir: dir, relPath: input.path });
    if (!res.ok) throw new Error(res.error);
    return res.data as { text: string; size: number };
  }),

  mkdir: machineProcedure.input(PathInput).mutation(async ({ ctx, input }) => {
    const dir = await agentDir(ctx.machine.id, input.agentName);
    const res = await requestFs(ctx.machine.id, 'mkdir', { agentDir: dir, relPath: input.path });
    if (!res.ok) throw new Error(res.error);
    return { ok: true };
  }),

  remove: machineProcedure.input(PathInput).mutation(async ({ ctx, input }) => {
    const dir = await agentDir(ctx.machine.id, input.agentName);
    const res = await requestFs(ctx.machine.id, 'remove', { agentDir: dir, relPath: input.path });
    if (!res.ok) throw new Error(res.error);
    return { ok: true };
  }),

  rename: machineProcedure
    .input(z.object({ agentName: z.string().min(1), path: z.string().min(1), toPath: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const dir = await agentDir(ctx.machine.id, input.agentName);
      const res = await requestFs(ctx.machine.id, 'rename', { agentDir: dir, relPath: input.path, toRelPath: input.toPath });
      if (!res.ok) throw new Error(res.error);
      return { ok: true };
    }),

  // Kick off a download: the gateway reads the file (or `zip -r`s the folder) and
  // streams it up to the dashboard stash. Returns an id the browser polls.
  prepareDownload: machineProcedure
    .input(z.object({ agentName: z.string().min(1), path: z.string().min(1), isFolder: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const dir = await agentDir(ctx.machine.id, input.agentName);
      const id = `dl_${randomUUID()}`;
      createDownload(id, ctx.machine.id);
      const res = await requestFs(ctx.machine.id, 'download', {
        agentDir: dir,
        relPath: input.path,
        downloadId: id,
        isFolder: input.isFolder,
      });
      if (!res.ok) throw new Error(res.error);
      return { id };
    }),

  // Poll until status === 'ready' (then GET /api/file-manager/download/<id>).
  downloadStatus: machineProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const d = getDownload(input.id);
    if (!d || d.machineId !== ctx.machine.id)
      return { status: 'error' as const, error: '下载已过期或不存在', filename: '', size: 0 };
    return { status: d.status, error: d.error ?? null, filename: d.filename, size: d.size };
  }),
});
