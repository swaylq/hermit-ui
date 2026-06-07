import { z } from 'zod';
import crypto from 'node:crypto';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import { resolveImport, parseFrontmatter } from '../market-import';
import { buildTemplate } from '../market-template';

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
        // GlobalSkill.refs are { name, content } (from the skill's references/
        // dir); the market detail + install both key on `path`. Normalize to a
        // real relative path so files keep their names and install writes them.
        refs = ((g.refs as Array<{ name?: string; path?: string; content?: string }>) ?? [])
          .map((r) => ({ path: r.path ?? (r.name ? `references/${r.name}` : ''), content: String(r.content ?? '') }))
          .filter((r) => !!r.path);
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

      // Fall back to the SKILL.md frontmatter description so agent uploads — whose
      // cached {name,content} carries no parsed description, and whose publish
      // dialog has no description field — still land with a description in the
      // market instead of a blank card. (Imports + global skills already have one.)
      if (!desc && content) desc = parseFrontmatter(content).description ?? null;

      const slug = input.slug ?? boundSlug ?? input.skillName;
      if (!SLUG_RE.test(slug)) throw new Error('invalid slug (lowercase letter, then letters/digits/hyphens)');
      const displayName = input.displayName || slug;
      const hash = hashContent(content, refs);
      const fileCount = 1 + refs.length;

      const existing = await prisma.marketSkill.findUnique({
        where: { slug }, include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });

      let result: { id: string; slug: string; latestVersion: string };
      let created = true; // did this publish actually append a new version?
      if (existing) {
        if (existing.versions[0]?.contentHash === hash) {
          result = existing; // identical content → no new version appended
          created = false;
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
      // `created` lets the UI distinguish a real new version from a no-op
      // re-publish of identical content (often: the edit hasn't synced to the
      // DB cache yet — agent.skills refreshes a few seconds after the gateway
      // applies the edit), instead of silently showing "published" either way.
      return { id: result.id, slug: result.slug, latestVersion: result.latestVersion, created };
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
  // the gateway's editAgentFile mkdir+overwrites — plus the version's sub-files
  // (refs) so the whole skill tree lands on disk, then binds. "Pull update" and
  // "install from market" are the same op.
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
        data: { machineId: ctx.machine.id, kind: 'edit', agentName: input.agentName, target: `skill:${input.slug}`, content: ver.content, refs: ver.refs ?? undefined },
      });
      await prisma.agentSkillInstall.upsert({
        where: { machineId_agentName_skillName: { machineId: ctx.machine.id, agentName: input.agentName, skillName: input.slug } },
        create: { machineId: ctx.machine.id, agentName: input.agentName, skillName: input.slug, marketSkillId: market.id, marketVersion: market.latestVersion },
        update: { marketSkillId: market.id, marketVersion: market.latestVersion },
      });
      return { ok: true, version: market.latestVersion };
    }),

  uninstallAgentSkill: machineProcedure
    .input(z.object({ agentName: z.string(), skillName: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!SKILL_NAME_RE.test(input.skillName)) throw new Error('invalid skill name');
      await prisma.agentRequest.create({
        data: { machineId: ctx.machine.id, kind: 'delete-skill', agentName: input.agentName, target: `skill:${input.skillName}` },
      });
      await prisma.agentSkillInstall.deleteMany({
        where: { machineId: ctx.machine.id, agentName: input.agentName, skillName: input.skillName },
      });
      return { ok: true };
    }),

  // ── Machine level (~/.claude/skills) — mirror of the agent procedures ────────
  installToMachine: machineProcedure.input(z.object({ slug: z.string() })).mutation(async ({ ctx, input }) => {
    if (!SKILL_NAME_RE.test(input.slug)) throw new Error('skill slug invalid for an on-disk skill name');
    const market = await prisma.marketSkill.findUnique({
      where: { slug: input.slug },
      include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (!market) throw new Error('market skill not found');
    const ver = market.versions[0];
    if (!ver || ver.content == null) throw new Error('market skill has no installable SKILL.md');
    const exists = await prisma.globalSkill.findUnique({
      where: { machineId_name: { machineId: ctx.machine.id, name: input.slug } },
      select: { isBundle: true },
    });
    if (exists?.isBundle) throw new Error('a managed bundle with that name exists — refusing to overwrite');
    await prisma.globalSkillRequest.create({
      data: { machineId: ctx.machine.id, kind: exists ? 'edit' : 'create', skillName: input.slug, content: ver.content, refs: ver.refs ?? undefined },
    });
    // Provenance — preserved across the gateway's filesystem push (its upsert
    // `update` clause never touches marketSkillId). Optimistic create so /skills
    // shows the skill before the gateway writes it.
    await prisma.globalSkill.upsert({
      where: { machineId_name: { machineId: ctx.machine.id, name: input.slug } },
      create: { machineId: ctx.machine.id, name: input.slug, content: ver.content, description: market.description, marketSkillId: market.id, marketVersion: market.latestVersion },
      update: { marketSkillId: market.id, marketVersion: market.latestVersion },
    });
    return { ok: true, version: market.latestVersion };
  }),

  globalSkillStatus: machineProcedure.query(async ({ ctx }) => {
    const skills = await prisma.globalSkill.findMany({
      where: { machineId: ctx.machine.id, marketSkillId: { not: null } },
      select: { name: true, marketSkillId: true, marketVersion: true },
    });
    if (skills.length === 0) return [];
    const markets = await prisma.marketSkill.findMany({
      where: { id: { in: skills.map((s) => s.marketSkillId!).filter(Boolean) } },
      select: { id: true, slug: true, latestVersion: true },
    });
    const byId = new Map(markets.map((m) => [m.id, m]));
    return skills.map((s) => {
      const m = s.marketSkillId ? byId.get(s.marketSkillId) : undefined;
      return {
        name: s.name,
        slug: m?.slug ?? null,
        installedVersion: s.marketVersion,
        latestVersion: m?.latestVersion ?? null,
        hasUpdate: !!m && m.latestVersion !== s.marketVersion,
      };
    });
  }),

  // ── External import (Phase C) — server-side fetch, preview then commit ───────
  previewImport: machineProcedure.input(z.object({ url: z.string().url() })).mutation(async ({ input }) => {
    const r = await resolveImport(input.url);
    return { slug: r.slug, displayName: r.displayName, description: r.description, content: r.content, refCount: r.refs.length, origin: r.origin, originUrl: r.originUrl };
  }),

  commitImport: machineProcedure
    .input(z.object({
      url: z.string().url(),
      slug: z.string().trim().toLowerCase().regex(SLUG_RE).optional(),
      displayName: z.string().trim().optional(),
      changelog: z.string().trim().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const r = await resolveImport(input.url); // re-fetch server-side — never trust client content
      const slug = input.slug ?? r.slug;
      if (!SLUG_RE.test(slug)) throw new Error('invalid slug');
      const displayName = input.displayName || r.displayName || slug;
      const hash = hashContent(r.content, r.refs);
      const fileCount = 1 + r.refs.length;
      const changelog = input.changelog ?? `imported from ${r.originUrl}`;
      const existing = await prisma.marketSkill.findUnique({
        where: { slug }, include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (existing) {
        if (existing.versions[0]?.contentHash === hash) return existing;
        const nextVer = String((parseInt(existing.latestVersion, 10) || 0) + 1);
        await prisma.marketSkillVersion.create({
          data: { marketSkillId: existing.id, version: nextVer, content: r.content, refs: r.refs, fileCount, contentHash: hash, changelog, createdByMachineId: ctx.machine.id },
        });
        return prisma.marketSkill.update({
          where: { id: existing.id },
          data: { latestVersion: nextVer, description: r.description, displayName, origin: r.origin, originUrl: r.originUrl },
        });
      }
      return prisma.marketSkill.create({
        data: {
          slug, displayName, description: r.description, origin: r.origin, originUrl: r.originUrl, latestVersion: '1',
          publishedByMachineId: ctx.machine.id,
          versions: { create: { version: '1', content: r.content, refs: r.refs, fileCount, contentHash: hash, changelog, createdByMachineId: ctx.machine.id } },
        },
      });
    }),

  // ── Templates (Phase D) — condense an agent → template, stripping private ────
  templatePreview: machineProcedure.input(z.object({ agentName: z.string() })).query(async ({ ctx, input }) => {
    const a = await prisma.agent.findUnique({
      where: { machineId_name: { machineId: ctx.machine.id, name: input.agentName } },
      select: { name: true, identityText: true, agentsText: true, skills: true, skillNames: true },
    });
    if (!a) throw new Error('agent not found');
    const t = buildTemplate({ name: a.name, identityText: a.identityText, agentsText: a.agentsText, skills: (a.skills as Array<{ name: string; content: string }>) ?? [], skillNames: a.skillNames });
    return { kept: t.kept, stripped: t.stripped, fileCount: t.files.length, basePersona: t.basePersona };
  }),

  publishTemplateFromAgent: machineProcedure
    .input(z.object({
      agentName: z.string(),
      slug: z.string().trim().toLowerCase().regex(SLUG_RE).optional(),
      displayName: z.string().trim().optional(),
      description: z.string().trim().optional(),
      changelog: z.string().trim().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const a = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.agentName } },
        select: { name: true, identityText: true, agentsText: true, skills: true, skillNames: true },
      });
      if (!a) throw new Error('agent not found');
      const t = buildTemplate({ name: a.name, identityText: a.identityText, agentsText: a.agentsText, skills: (a.skills as Array<{ name: string; content: string }>) ?? [], skillNames: a.skillNames });
      if (t.files.length === 0) throw new Error('nothing to publish yet — the agent identity/skills haven\'t synced');
      const slug = input.slug ?? a.name; // agent names are already valid slugs
      if (!SLUG_RE.test(slug)) throw new Error('invalid slug');
      const displayName = input.displayName || a.name;
      const changelog = input.changelog ?? null;
      const existing = await prisma.marketTemplate.findUnique({ where: { slug }, include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } } });
      if (existing) {
        const nextVer = String((parseInt(existing.latestVersion, 10) || 0) + 1);
        await prisma.marketTemplateVersion.create({ data: { marketTemplateId: existing.id, version: nextVer, files: t.files, includedSkills: a.skillNames, changelog } });
        return prisma.marketTemplate.update({ where: { id: existing.id }, data: { latestVersion: nextVer, displayName, description: input.description ?? existing.description, basePersona: t.basePersona, sourceAgent: a.name } });
      }
      return prisma.marketTemplate.create({
        data: {
          slug, displayName, description: input.description ?? null, basePersona: t.basePersona, origin: 'uploaded',
          sourceAgent: a.name, publishedByMachineId: ctx.machine.id, latestVersion: '1',
          versions: { create: { version: '1', files: t.files, includedSkills: a.skillNames, changelog } },
        },
      });
    }),
});
