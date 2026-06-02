import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

// Machine-global skills under ~/.claude/skills/ on the gateway host — shared by
// every Claude Code session there, not scoped to an agent. The gateway scans the
// directory and pushes (filesystem is leader; see /api/sync/global-skills);
// create/edit/delete round-trip through GlobalSkillRequest, mirroring the agents
// router. Bundles (git/plugin frameworks with nested skills/) are READ-ONLY —
// edit/delete are refused so the dashboard never fights an upstream.

const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_CONTENT = 256 * 1024; // 256 KB — SKILL.md can be large

export const skillsRouter = router({
  list: machineProcedure.query(async ({ ctx }) => {
    return prisma.globalSkill.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, description: true, source: true,
        isBundle: true, subSkills: true, fileCount: true, metadataAt: true,
      },
    });
  }),

  get: machineProcedure.input(z.object({ name: z.string() })).query(async ({ ctx, input }) => {
    const skill = await prisma.globalSkill.findUnique({
      where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
    });
    if (!skill) return null;
    return { skill };
  }),

  // ── Dashboard-driven lifecycle (round-trips through the gateway) ────────────
  requestCreate: machineProcedure
    .input(z.object({
      name: z.string().trim().toLowerCase()
        .regex(NAME_RE, 'name must be lowercase: a letter then letters/digits/hyphens, ≤41 chars'),
      content: z.string().min(1, 'SKILL.md content required').max(MAX_CONTENT, 'content too large (>256KB)'),
    }))
    .mutation(async ({ ctx, input }) => {
      const exists = await prisma.globalSkill.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { id: true },
      });
      if (exists) throw new Error(`skill "${input.name}" already exists`);
      const pending = await prisma.globalSkillRequest.findFirst({
        where: { machineId: ctx.machine.id, skillName: input.name, status: 'pending' },
        select: { id: true },
      });
      if (pending) throw new Error(`a request for "${input.name}" is already pending`);
      return prisma.globalSkillRequest.create({
        data: { machineId: ctx.machine.id, kind: 'create', skillName: input.name, content: input.content },
      });
    }),

  requestEdit: machineProcedure
    .input(z.object({
      name: z.string(),
      content: z.string().min(1, 'SKILL.md content required').max(MAX_CONTENT, 'content too large (>256KB)'),
    }))
    .mutation(async ({ ctx, input }) => {
      const skill = await prisma.globalSkill.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { isBundle: true },
      });
      if (!skill) throw new Error('skill not found');
      if (skill.isBundle) throw new Error('this is a managed bundle (git/plugin) — edit it at its source, not here');
      return prisma.globalSkillRequest.create({
        data: { machineId: ctx.machine.id, kind: 'edit', skillName: input.name, content: input.content },
      });
    }),

  requestDelete: machineProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const skill = await prisma.globalSkill.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { isBundle: true },
      });
      if (!skill) throw new Error('skill not found');
      if (skill.isBundle) throw new Error('this is a managed bundle (git/plugin) — remove it at its source, not here');
      const pending = await prisma.globalSkillRequest.findFirst({
        where: { machineId: ctx.machine.id, skillName: input.name, status: 'pending' },
      });
      if (pending) return pending; // already queued
      return prisma.globalSkillRequest.create({
        data: { machineId: ctx.machine.id, kind: 'delete', skillName: input.name },
      });
    }),

  // Pending lifecycle requests — the /skills page shows "creating…/deleting…".
  pendingRequests: machineProcedure.query(async ({ ctx }) => {
    return prisma.globalSkillRequest.findMany({
      where: { machineId: ctx.machine.id, status: 'pending' },
      select: { id: true, kind: true, skillName: true, requestedAt: true },
    });
  }),

  // ── Gateway endpoints ──────────────────────────────────────────────────────
  // Gateway polls ~every 3s, writes/removes ~/.claude/skills/<name>/, then acks.
  pollRequests: machineProcedure.query(async ({ ctx }) => {
    return prisma.globalSkillRequest.findMany({
      where: { machineId: ctx.machine.id, status: 'pending' },
      orderBy: { requestedAt: 'asc' },
    });
  }),

  ackRequest: machineProcedure
    .input(z.object({ id: z.string(), status: z.enum(['done', 'error']), error: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const r = await prisma.globalSkillRequest.findUnique({ where: { id: input.id } });
      if (!r || r.machineId !== ctx.machine.id) throw new Error('not found');
      // On a successful delete, drop the row now so the UI reflects it without
      // waiting for the next filesystem scan (which would also remove it).
      if (r.kind === 'delete' && input.status === 'done') {
        await prisma.globalSkill.deleteMany({ where: { machineId: ctx.machine.id, name: r.skillName } });
      }
      return prisma.globalSkillRequest.update({
        where: { id: input.id },
        data: { status: input.status, error: input.error ?? null, resolvedAt: new Date() },
      });
    }),
});
