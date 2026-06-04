import { z } from 'zod';
import crypto from 'node:crypto';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

// Fleet-global marketplace registry — the Market* tables are NOT machineId-scoped
// (every machine connected to this dashboard sees the same market). Procedures
// still authenticate via machineProcedure; `ctx.machine` is used only for the
// publish source (machine-scoped) + provenance. See docs/marketplace-design.md.

const SLUG_RE = /^[a-z][a-z0-9-]{0,60}$/;
type Ref = { path: string; content: string };

function hashContent(content: string | null, refs: Ref[]): string {
  return crypto.createHash('sha256').update(JSON.stringify({ content, refs })).digest('hex').slice(0, 16);
}

export const marketRouter = router({
  // ── Browse (fleet-global) ──────────────────────────────────────────────────
  listSkills: machineProcedure
    .input(z.object({ q: z.string().optional(), category: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const where: Record<string, unknown> = {};
      if (input?.q) {
        where.OR = [
          { slug: { contains: input.q, mode: 'insensitive' } },
          { displayName: { contains: input.q, mode: 'insensitive' } },
          { description: { contains: input.q, mode: 'insensitive' } },
        ];
      }
      if (input?.category) where.category = input.category;
      return prisma.marketSkill.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true, slug: true, displayName: true, description: true,
          origin: true, category: true, tags: true, latestVersion: true, updatedAt: true,
        },
      });
    }),

  getSkill: machineProcedure.input(z.object({ slug: z.string() })).query(async ({ input }) => {
    return prisma.marketSkill.findUnique({
      where: { slug: input.slug },
      include: { versions: { orderBy: { createdAt: 'desc' } } },
    });
  }),

  listTemplates: machineProcedure.query(async () => {
    return prisma.marketTemplate.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, slug: true, displayName: true, description: true,
        origin: true, sourceAgent: true, latestVersion: true, updatedAt: true,
      },
    });
  }),

  getTemplate: machineProcedure.input(z.object({ slug: z.string() })).query(async ({ input }) => {
    return prisma.marketTemplate.findUnique({
      where: { slug: input.slug },
      include: { versions: { orderBy: { createdAt: 'desc' } } },
    });
  }),

  // ── Seed publish: an existing machine GlobalSkill or agent skill → market ────
  localSkills: machineProcedure.query(async ({ ctx }) => {
    return prisma.globalSkill.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: { name: 'asc' },
      select: { name: true, description: true, isBundle: true },
    });
  }),

  publishSkillFromLocal: machineProcedure
    .input(z.object({
      source: z.enum(['global', 'agent']),
      skillName: z.string(),
      agentName: z.string().optional(),
      slug: z.string().trim().toLowerCase().regex(SLUG_RE).optional(),
      displayName: z.string().trim().optional(),
      description: z.string().trim().optional(),
      changelog: z.string().trim().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      let content: string | null = null;
      let refs: Ref[] = [];
      let desc = input.description ?? null;

      if (input.source === 'global') {
        const g = await prisma.globalSkill.findUnique({
          where: { machineId_name: { machineId: ctx.machine.id, name: input.skillName } },
        });
        if (!g) throw new Error('global skill not found');
        content = g.content;
        refs = (g.refs as Ref[]) ?? [];
        desc = desc ?? g.description ?? null;
      } else {
        if (!input.agentName) throw new Error('agentName required for agent source');
        const a = await prisma.agent.findUnique({
          where: { machineId_name: { machineId: ctx.machine.id, name: input.agentName } },
          select: { skills: true },
        });
        if (!a) throw new Error('agent not found');
        const arr = (a.skills as Array<{ name: string; content: string }>) ?? [];
        const s = arr.find((x) => x.name === input.skillName);
        if (!s) throw new Error('agent skill not found');
        content = s.content;
        refs = []; // agent skills carry SKILL.md only today (spec note)
      }

      const slug = input.slug ?? input.skillName;
      if (!SLUG_RE.test(slug)) throw new Error('invalid slug (lowercase letter, then letters/digits/hyphens)');
      const displayName = input.displayName || slug;
      const hash = hashContent(content, refs);
      const fileCount = 1 + refs.length;

      const existing = await prisma.marketSkill.findUnique({
        where: { slug },
        include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (existing) {
        if (existing.versions[0]?.contentHash === hash) return existing; // identical re-publish → no-op
        const nextVer = String((parseInt(existing.latestVersion, 10) || 0) + 1);
        await prisma.marketSkillVersion.create({
          data: {
            marketSkillId: existing.id, version: nextVer, content, refs, fileCount,
            contentHash: hash, changelog: input.changelog ?? null, createdByMachineId: ctx.machine.id,
          },
        });
        return prisma.marketSkill.update({
          where: { id: existing.id },
          data: { latestVersion: nextVer, description: desc, displayName },
        });
      }
      return prisma.marketSkill.create({
        data: {
          slug, displayName, description: desc, origin: 'uploaded', latestVersion: '1',
          publishedByMachineId: ctx.machine.id,
          publishedByAgent: input.source === 'agent' ? input.agentName : null,
          versions: {
            create: {
              version: '1', content, refs, fileCount,
              contentHash: hash, changelog: input.changelog ?? null, createdByMachineId: ctx.machine.id,
            },
          },
        },
      });
    }),
});
