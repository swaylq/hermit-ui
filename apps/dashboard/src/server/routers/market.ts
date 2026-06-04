import { z } from 'zod';
import crypto from 'node:crypto';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

// Fleet-global marketplace registry — the Market* tables are NOT machineId-scoped
// (every machine connected to this dashboard sees the same market). Procedures
// authenticate via machineProcedure; `ctx.machine` is used for the machine-scoped
// publish source + install target + binding provenance. See docs/marketplace-design.md.

const SLUG_RE = /^[a-z][a-z0-9-]{0,60}$/;
// Installable skill name == the on-disk dir under .claude/skills/. Must satisfy
// the gateway's stricter target regex (agent-lifecycle.ts / global-skills.ts).
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
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

  localSkills: machineProcedure.query(async ({ ctx }) => {
    return prisma.globalSkill.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: { name: 'asc' },
      select: { name: true, description: true, isBundle: true },
    });
  }),

  // ── Publish: a machine GlobalSkill or agent skill → market ──────────────────
  // A skill published (or installed) from an agent is BOUND via AgentSkillInstall;
  // a machine skill via GlobalSkill.marketSkillId. Re-publishing a bound skill
  // targets the SAME market skill (its slug) and appends a version.
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
      let boundSlug: string | null = null;

      if (input.source === 'global') {
        const g = await prisma.globalSkill.findUnique({
          where: { machineId_name: { machineId: ctx.machine.id, name: input.skillName } },
        });
        if (!g) throw new Error('global skill not found');
        content = g.content;
        refs = (g.refs as Ref[]) ?? [];
        desc = desc ?? g.description ?? null;
        if (g.marketSkillId) {
          boundSlug = (await prisma.marketSkill.findUnique({ where: { id: g.marketSkillId }, select: { slug: true } }))?.slug ?? null;
        }
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
        const bind = await prisma.agentSkillInstall.findUnique({
          where: { machineId_agentName_skillName: { machineId: ctx.machine.id, agentName: input.agentName, skillName: input.skillName } },
        });
        if (bind) {
          boundSlug = (await prisma.marketSkill.findUnique({ where: { id: bind.marketSkillId }, select: { slug: true } }))?.slug ?? null;
        }
      }

      const slug = input.slug ?? boundSlug ?? input.skillName;
      if (!SLUG_RE.test(slug)) throw new Error('invalid slug (lowercase letter, then letters/digits/hyphens)');
      const displayName = input.displayName || slug;
      const hash = hashContent(content, refs);
      const fileCount = 1 + refs.length;

      const existing = await prisma.marketSkill.findUnique({
        where: { slug }, include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });

      let result: { id: string; slug: string; latestVersion: string };
      if (existing) {
        if (existing.versions[0]?.contentHash === hash) {
          result = existing; // identical re-publish → no new version
        } else {
          const nextVer = String((parseInt(existing.latestVersion, 10) || 0) + 1);
          await prisma.marketSkillVersion.create({
            data: { marketSkillId: existing.id, version: nextVer, content, refs, fileCount, contentHash: hash, changelog: input.changelog ?? null, createdByMachineId: ctx.machine.id },
          });
          result = await prisma.marketSkill.update({
            where: { id: existing.id }, data: { latestVersion: nextVer, description: desc, displayName },
          });
        }
      } else {
        result = await prisma.marketSkill.create({
          data: {
            slug, displayName, description: desc, origin: 'uploaded', latestVersion: '1',
            publishedByMachineId: ctx.machine.id,
            publishedByAgent: input.source === 'agent' ? input.agentName : null,
            versions: { create: { version: '1', content, refs, fileCount, contentHash: hash, changelog: input.changelog ?? null, createdByMachineId: ctx.machine.id } },
          },
        });
      }

      // Bind the local copy to the market skill at the just-published version.
      if (input.source === 'agent' && input.agentName) {
        await prisma.agentSkillInstall.upsert({
          where: { machineId_agentName_skillName: { machineId: ctx.machine.id, agentName: input.agentName, skillName: input.skillName } },
          create: { machineId: ctx.machine.id, agentName: input.agentName, skillName: input.skillName, marketSkillId: result.id, marketVersion: result.latestVersion },
          update: { marketSkillId: result.id, marketVersion: result.latestVersion },
        });
      } else if (input.source === 'global') {
        await prisma.globalSkill.update({
          where: { machineId_name: { machineId: ctx.machine.id, name: input.skillName } },
          data: { marketSkillId: result.id, marketVersion: result.latestVersion },
        });
      }
      return result;
    }),

  // ── Update detection ────────────────────────────────────────────────────────
  // Bound skills of an agent + whether the market has a newer version.
  agentSkillStatus: machineProcedure.input(z.object({ agentName: z.string() })).query(async ({ ctx, input }) => {
    const binds = await prisma.agentSkillInstall.findMany({
      where: { machineId: ctx.machine.id, agentName: input.agentName },
    });
    if (binds.length === 0) return [];
    const markets = await prisma.marketSkill.findMany({
      where: { id: { in: binds.map((b) => b.marketSkillId) } },
      select: { id: true, slug: true, latestVersion: true },
    });
    const byId = new Map(markets.map((m) => [m.id, m]));
    return binds.map((b) => {
      const m = byId.get(b.marketSkillId);
      return {
        skillName: b.skillName,
        slug: m?.slug ?? null,
        installedVersion: b.marketVersion,
        latestVersion: m?.latestVersion ?? null,
        hasUpdate: !!m && m.latestVersion !== b.marketVersion,
      };
    });
  }),

  // ── Install / update a market skill into an agent ───────────────────────────
  // Writes the latest version's SKILL.md via AgentRequest(edit, skill:<slug>) —
  // the gateway's editAgentFile mkdir+overwrites — then binds. "Pull update" and
  // "install from market" are the same op. (v1: SKILL.md only; refs deferred.)
  installToAgent: machineProcedure
    .input(z.object({ slug: z.string(), agentName: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!SKILL_NAME_RE.test(input.slug)) throw new Error('skill slug too long / invalid for an on-disk skill name');
      const market = await prisma.marketSkill.findUnique({
        where: { slug: input.slug },
        include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (!market) throw new Error('market skill not found');
      const ver = market.versions[0];
      if (!ver || ver.content == null) throw new Error('market skill has no installable SKILL.md');
      const agent = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.agentName } },
        select: { id: true },
      });
      if (!agent) throw new Error('agent not found');

      await prisma.agentRequest.create({
        data: { machineId: ctx.machine.id, kind: 'edit', agentName: input.agentName, target: `skill:${input.slug}`, content: ver.content },
      });
      await prisma.agentSkillInstall.upsert({
        where: { machineId_agentName_skillName: { machineId: ctx.machine.id, agentName: input.agentName, skillName: input.slug } },
        create: { machineId: ctx.machine.id, agentName: input.agentName, skillName: input.slug, marketSkillId: market.id, marketVersion: market.latestVersion },
        update: { marketSkillId: market.id, marketVersion: market.latestVersion },
      });
      return { ok: true, version: market.latestVersion };
    }),

  // Agents this machine owns — for the "install to agent" picker.
  installTargets: machineProcedure.query(async ({ ctx }) => {
    return prisma.agent.findMany({
      where: { machineId: ctx.machine.id, trashedAt: null },
      orderBy: { name: 'asc' },
      select: { name: true },
    });
  }),
});
