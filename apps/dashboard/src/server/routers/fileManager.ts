// File manager. Interactive metadata ops (list / readText / writeText / mkdir /
// remove / rename) are forwarded LIVE to the target machine's gateway over the
// control-channel bridge (gateway-bridge.ts → fs.req/fs.res) so the browser feels
// instant. Bulk download is prepared by the gateway and streamed up to the
// dashboard stash (/api/file-manager/ingest); the browser then pulls it from
// /api/file-manager/download/<id>. Upload reuses the existing File Station path.
//
// Two targets: an agent's own directory (agentName → Agent.directory, resolved
// here) or this machine's ~/.claude/global-memory folder (globalMemory:true — the
// gateway resolves its own home, since the dashboard can't know it).

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { router, agentProcedure } from '../trpc';
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

// The base-directory selector passed to the gateway: either a resolved agentDir
// or the global-memory root marker (resolved gateway-side). A scoped share key is
// the chokepoint here — it may only reach ITS agent's directory, never the
// machine-global memory folder and never a sibling agent.
async function fsTarget(
  ctx: { machine: { id: string }; scopedAgent: string | null },
  input: { agentName?: string; globalMemory?: boolean },
): Promise<Record<string, string>> {
  if (ctx.scopedAgent) {
    if (input.globalMemory) throw new Error('global memory is not part of a shared agent');
    if (input.agentName !== ctx.scopedAgent) throw new Error('outside the shared agent');
  }
  if (input.globalMemory) return { root: 'global-memory' };
  if (!input.agentName) throw new Error('agentName required');
  return { agentDir: await agentDir(ctx.machine.id, input.agentName) };
}

type ListData = { entries: Array<{ name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number }>; truncated: boolean };

// agentName XOR globalMemory; path defaults to the root.
const PathInput = z.object({
  agentName: z.string().min(1).optional(),
  globalMemory: z.boolean().default(false),
  path: z.string().default(''),
});

export const fileManagerRouter = router({
  // Directory listing — folders first, capped (the gateway truncates huge dirs).
  list: agentProcedure.input(PathInput).query(async ({ ctx, input }) => {
    const target = await fsTarget(ctx, input);
    const res = await requestFs(ctx.machine.id, 'list', { ...target, relPath: input.path });
    if (!res.ok) throw new Error(res.error);
    return res.data as ListData;
  }),

  // Text preview of a single file (gateway rejects binary / >256 KB).
  readText: agentProcedure.input(PathInput).query(async ({ ctx, input }) => {
    const target = await fsTarget(ctx, input);
    const res = await requestFs(ctx.machine.id, 'readText', { ...target, relPath: input.path });
    if (!res.ok) throw new Error(res.error);
    return res.data as { text: string; size: number };
  }),

  // Create / overwrite a text file (in-browser authoring — global-memory folder).
  writeText: agentProcedure
    .input(z.object({
      agentName: z.string().min(1).optional(),
      globalMemory: z.boolean().default(false),
      path: z.string().min(1),
      text: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const target = await fsTarget(ctx, input);
      const res = await requestFs(ctx.machine.id, 'writeText', { ...target, relPath: input.path, text: input.text });
      if (!res.ok) throw new Error(res.error);
      return { ok: true };
    }),

  mkdir: agentProcedure.input(PathInput).mutation(async ({ ctx, input }) => {
    const target = await fsTarget(ctx, input);
    const res = await requestFs(ctx.machine.id, 'mkdir', { ...target, relPath: input.path });
    if (!res.ok) throw new Error(res.error);
    return { ok: true };
  }),

  remove: agentProcedure.input(PathInput).mutation(async ({ ctx, input }) => {
    const target = await fsTarget(ctx, input);
    const res = await requestFs(ctx.machine.id, 'remove', { ...target, relPath: input.path });
    if (!res.ok) throw new Error(res.error);
    return { ok: true };
  }),

  rename: agentProcedure
    .input(z.object({
      agentName: z.string().min(1).optional(),
      globalMemory: z.boolean().default(false),
      path: z.string().min(1),
      toPath: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const target = await fsTarget(ctx, input);
      const res = await requestFs(ctx.machine.id, 'rename', { ...target, relPath: input.path, toRelPath: input.toPath });
      if (!res.ok) throw new Error(res.error);
      return { ok: true };
    }),

  // Kick off a download: the gateway reads the file (or `zip -r`s the folder) and
  // streams it up to the dashboard stash. Returns an id the browser polls.
  prepareDownload: agentProcedure
    .input(z.object({
      agentName: z.string().min(1).optional(),
      globalMemory: z.boolean().default(false),
      path: z.string().min(1),
      isFolder: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const target = await fsTarget(ctx, input);
      const id = `dl_${randomUUID()}`;
      // Stamp the owner agent (null for a machine-scoped global-memory download) so
      // downloadStatus + the byte route can enforce it against a scoped share key.
      createDownload(id, ctx.machine.id, input.globalMemory ? null : input.agentName ?? null);
      const res = await requestFs(ctx.machine.id, 'download', {
        ...target,
        relPath: input.path,
        downloadId: id,
        isFolder: input.isFolder,
      });
      if (!res.ok) throw new Error(res.error);
      return { id };
    }),

  // Poll until status === 'ready' (then GET /api/file-manager/download/<id>).
  downloadStatus: agentProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const d = getDownload(input.id);
    // Ownership: same machine AND (for a scoped share key) the download must belong to
    // the caller's own agent — a scoped key must never see a sibling agent's download,
    // even its metadata. Matches the assertAgent pattern every other id-keyed endpoint
    // in this router follows (was the one gap: id-keyed with only a machineId check).
    if (!d || d.machineId !== ctx.machine.id || (ctx.scopedAgent && d.agentName !== ctx.scopedAgent))
      return { status: 'error' as const, error: '下载已过期或不存在', filename: '', size: 0 };
    return { status: d.status, error: d.error ?? null, filename: d.filename, size: d.size };
  }),
});
