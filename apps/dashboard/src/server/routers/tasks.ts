// Two flavors of "task":
//   - launchAgents: read-only listing of macOS LaunchAgents (legacy infra,
//     surfaced on the Agent detail sheet so sway can see boot/cron plists)
//   - systemTasks:  user-defined cron-style tasks managed by the dashboard
//     scheduler. CRUD via this router.

import { z } from 'zod';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { ensureSnapshot } from '../collect/snapshot';

const SAFE_LABEL = /^ai\.(claudeclaw|openclaw)\.[\w.-]+$/;

function classify(logPath: string | null): 'ok' | 'warn' | 'fail' | 'unknown' {
  if (!logPath) return 'unknown';
  try {
    if (!fs.existsSync(logPath)) return 'unknown';
    const r = spawnSync('sh', ['-c', `tail -n 30 ${JSON.stringify(logPath)} 2>/dev/null`], {
      encoding: 'utf8',
      timeout: 1500,
    });
    const text = (r.stdout || '').toLowerCase();
    if (!text.trim()) return 'unknown';
    if (/\b(panic|fatal|error|exception|failed|traceback)\b/.test(text)) return 'fail';
    if (/\bwarn(?:ing)?\b/.test(text)) return 'warn';
    return 'ok';
  } catch {
    return 'unknown';
  }
}

const TaskInput = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase, [a-z0-9._-]'),
  agentName: z.string().min(1).max(64),
  directory: z.string().optional(),
  prompt: z.string().min(1).max(16_000),
  intervalSec: z.number().int().min(60).max(86_400),
  enabled: z.boolean().default(true),
});

export const tasksRouter = router({
  // ─── LaunchAgent listing (read-only) ──────────────────────────────────────
  list: machineProcedure.query(async ({ ctx }) => {
    await ensureSnapshot(ctx.machine.id);
    const rows = await prisma.launchAgentRecord.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: { label: 'asc' },
    });
    return rows.map((r) => ({ ...r, status: classify(r.logPath) }));
  }),
  tailLog: machineProcedure
    .input(z.object({ label: z.string(), lines: z.number().int().min(1).max(2000).default(200) }))
    .query(async ({ ctx, input }) => {
      if (!SAFE_LABEL.test(input.label)) throw new Error('bad label');
      const rec = await prisma.launchAgentRecord.findUnique({
        where: { machineId_label: { machineId: ctx.machine.id, label: input.label } },
      });
      if (!rec?.logPath) return { logPath: null, tail: '' };
      const r = spawnSync('sh', ['-c', `tail -n ${input.lines} ${JSON.stringify(rec.logPath)} 2>/dev/null`], {
        encoding: 'utf8',
        timeout: 3000,
      });
      return { logPath: rec.logPath, tail: r.stdout ?? '' };
    }),

  // ─── SystemTask CRUD ─────────────────────────────────────────────────────
  systemList: machineProcedure
    .input(z.object({ agentName: z.string().optional() }).default({}))
    .query(async ({ ctx, input }) => {
      return prisma.systemTask.findMany({
        where: {
          machineId: ctx.machine.id,
          ...(input.agentName ? { agentName: input.agentName } : {}),
        },
        orderBy: { name: 'asc' },
      });
    }),

  systemCreate: machineProcedure.input(TaskInput).mutation(async ({ ctx, input }) => {
    return prisma.systemTask.create({
      data: { machineId: ctx.machine.id, ...input },
    });
  }),

  systemUpdate: machineProcedure
    .input(z.object({ id: z.string() }).and(TaskInput.partial()))
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const existing = await prisma.systemTask.findUnique({ where: { id } });
      if (!existing || existing.machineId !== ctx.machine.id) throw new Error('not found');
      return prisma.systemTask.update({ where: { id }, data: patch });
    }),

  systemDelete: machineProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.systemTask.findUnique({ where: { id: input.id } });
      if (!existing || existing.machineId !== ctx.machine.id) throw new Error('not found');
      await prisma.systemTask.delete({ where: { id: input.id } });
      return { ok: true };
    }),

  // Manual fire — sets lastFire to far past so the next scheduler tick picks it up.
  systemRunNow: machineProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.systemTask.findUnique({ where: { id: input.id } });
      if (!existing || existing.machineId !== ctx.machine.id) throw new Error('not found');
      await prisma.systemTask.update({
        where: { id: input.id },
        data: { lastFire: new Date(0) },
      });
      return { ok: true };
    }),
});
