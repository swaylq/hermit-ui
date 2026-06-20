import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';
import {
  BRAIN_PERSONA, BRAIN_DREAM_PROMPT,
  BRAIN_TEMPLATE_VERSION, BRAIN_MANAGED_FILES, BRAIN_CREATE_FILES, BRAIN_DREAM_CRON,
} from '../brain-template';

// ── Brain reconciler (shared by setupBrain create + ensureBrain update) ──────
// Idempotent convergence for the machine's orchestrator. Called on every
// gateway startup (agents.ensureBrain) and from setupBrain. DB-only; the
// filesystem overlay is queued as an AgentRequest the gateway materializes.
// Does NOTHING if there's no orchestrator — Brain stays opt-in.
async function reconcileBrain(machineId: string): Promise<{ name: string | null }> {
  const brain = await prisma.agent.findFirst({
    where: { machineId, isOrchestrator: true, trashedAt: null },
    select: { name: true, directory: true, brainTemplateVersion: true },
  });
  if (!brain) return { name: null };

  // (a) Re-overlay the machine-managed files (the `dreaming` skill — never
  //     IDENTITY/memory) when the brain predates the current template version.
  //     Gate on no pending overlay so a duplicate isn't queued each tick; the
  //     version is stamped only when the gateway acks the overlay done (so a
  //     failed overlay auto-retries on the next tick).
  if (brain.brainTemplateVersion < BRAIN_TEMPLATE_VERSION) {
    const pendingOverlay = await prisma.agentRequest.findFirst({
      where: { machineId, agentName: brain.name, kind: 'overlay', status: 'pending' },
      select: { id: true },
    });
    if (!pendingOverlay) {
      await prisma.agentRequest.create({
        data: {
          machineId, kind: 'overlay', agentName: brain.name,
          content: JSON.stringify({ templateFiles: BRAIN_MANAGED_FILES, version: BRAIN_TEMPLATE_VERSION }),
        },
      });
    }
  }

  // (b) Ensure the Daily dream cron exists (match by agent + title; create if
  //     missing — fixes brains scaffolded before cron-seeding existed).
  let dream = await prisma.cron.findFirst({
    where: { machineId, agentName: brain.name, title: BRAIN_DREAM_CRON.title },
    select: { id: true, lastFire: true, nextFire: true },
  });
  if (!dream) {
    dream = await prisma.cron.create({
      data: {
        machineId, agentName: brain.name,
        title: BRAIN_DREAM_CRON.title, prompt: BRAIN_DREAM_PROMPT,
        intervalSec: BRAIN_DREAM_CRON.intervalSec, jitterSec: BRAIN_DREAM_CRON.jitterSec,
        nextFire: new Date(Date.now() + 6 * 60 * 60 * 1000),
      },
      select: { id: true, lastFire: true, nextFire: true },
    });
  }

  // (c) Trigger the FIRST dream once — but only after the skill is in place
  //     (version current) and the agent is scaffolded (directory set), and only
  //     if it has never dreamed. So a fresh/updated brain self-populates its
  //     memory/roster.md in minutes, not up to 24h. lastFire!=null ⇒ never again.
  if (
    dream.lastFire == null &&
    brain.directory &&
    brain.brainTemplateVersion >= BRAIN_TEMPLATE_VERSION
  ) {
    const now = Date.now();
    if (!dream.nextFire || dream.nextFire.getTime() > now) {
      await prisma.cron.update({ where: { id: dream.id }, data: { nextFire: new Date(now) } });
    }
  }

  return { name: brain.name };
}

// Dashboard reads agent state purely from postgres. The Mac-side gateway
// pushes:
//   /api/sync/agents          — static folder metadata (markdowns + skills)
//   /api/sync/session-snapshot — per-session runtime (pid/alive/ctx/etc.)
// There is NO filesystem activity on the VPS triggered by any tRPC call.
//
// Agent has no runtime concept anymore — runtime lives on ChatSession.
// Restart is per-session (chat.requestSessionRestart). Per-agent restart
// is gone.

export const agentsRouter = router({
  list: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.agent.findMany({
      // Trashed agents (soft-deleted) are hidden here — they live in listTrashed.
      where: { machineId: ctx.machine.id, trashedAt: null },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        directory: true,
        skillNames: true,
        metadataAt: true,
        isOrchestrator: true,
      },
    });
    if (rows.length === 0) return [];

    // Sessions count + active-sessions count per agent (one grouped query).
    const counts = await prisma.chatSession.groupBy({
      by: ['agentName', 'alive'],
      where: { machineId: ctx.machine.id, agentName: { in: rows.map((r) => r.name) } },
      _count: { _all: true },
    });
    const sessionCount = new Map<string, number>();
    const activeCount = new Map<string, number>();
    for (const c of counts) {
      sessionCount.set(c.agentName, (sessionCount.get(c.agentName) ?? 0) + c._count._all);
      if (c.alive) activeCount.set(c.agentName, (activeCount.get(c.agentName) ?? 0) + c._count._all);
    }
    return rows.map(({ skillNames, ...r }) => ({
      ...r,
      // The sidebar only renders the *count*; the names themselves are read from
      // byName on the agent detail. Ship the count, not the per-agent names array
      // (~29% of this 10s-polled payload), so the wire stays lean.
      skillCount: skillNames.length,
      sessionCount: sessionCount.get(r.name) ?? 0,
      activeSessionCount: activeCount.get(r.name) ?? 0,
    }));
  }),

  // The recycle bin: agents soft-deleted (trashedAt set) but not yet purged.
  listTrashed: machineProcedure.query(async ({ ctx }) => {
    return prisma.agent.findMany({
      where: { machineId: ctx.machine.id, trashedAt: { not: null } },
      orderBy: { trashedAt: 'desc' },
      select: { id: true, name: true, directory: true, trashedAt: true, skillNames: true },
    });
  }),

  byName: machineProcedure
    .input(z.object({ name: z.string() }))
    .query(async ({ ctx, input }) => {
      const agent = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        // Everything the detail sheet renders EXCEPT the heavy evolutionFiles /
        // memoryFiles JSON — those load once via `folders`, not on the sheet's
        // 30s refetch. For a big auto-memory this drops ~200KB per refetch.
        // The markdown texts (identity/user/agents/tools, ~22KB) moved to the
        // once-fetched agents.coreTexts query — they're shown in a collapsed
        // FileList, not needed on byName's 30s/4s detail poll. evolutionLessons /
        // memorySummary were dead weight here (rendered nowhere — the evolution /
        // memory folders come from agents.folders). byName now carries just
        // names + metadata (~2KB).
        select: {
          id: true, name: true, directory: true, trashedAt: true, updatedAt: true,
          skillNames: true, skills: true, metadataAt: true, isOrchestrator: true,
        },
      });
      if (!agent) return null;
      // Strip per-skill refs AND the SKILL.md `content` from the response: both
      // can be large (content measured ~150KB for a skill-heavy agent) and byName
      // is fetched on hover + every 30s. The detail sheet lazy-loads the content
      // via `skillContents` (once) and refs via `skillRefs` (on open); byName now
      // carries only skill NAMES. The DB column keeps both, so skillContents /
      // skillRefs / publishSkillFromLocal still read them.
      if (Array.isArray(agent.skills)) {
        for (const s of agent.skills as Array<Record<string, unknown>>) {
          if (s && typeof s === 'object') { delete s.refs; delete s.content; }
        }
      }
      // Sessions are queried separately by the detail sheet via
      // chat.listSessions({ agentName }), so no need to join here.
      return { agent };
    }),

  // One skill's sub-file tree (everything besides SKILL.md), lazy-loaded when a
  // skill is opened in the detail sheet — kept OUT of byName's recurring payload.
  skillRefs: machineProcedure
    .input(z.object({ name: z.string(), skill: z.string() }))
    .query(async ({ ctx, input }) => {
      const agent = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { skills: true },
      });
      const skills = Array.isArray(agent?.skills)
        ? (agent!.skills as Array<{ name?: string; refs?: Array<{ path: string; content: string }> }>)
        : [];
      const found = skills.find((x) => x?.name === input.skill);
      return (found?.refs ?? []) as Array<{ path: string; content: string }>;
    }),

  // Per-skill SKILL.md content. Split out of byName (where it was the heavy ~150KB
  // part re-sent on every 30s detail poll) so the detail fetches the bodies ONCE
  // (long staleTime) instead of on each poll. byName now carries only skill names.
  skillContents: machineProcedure
    .input(z.object({ name: z.string() }))
    .query(async ({ ctx, input }) => {
      const agent = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { skills: true },
      });
      const skills = Array.isArray(agent?.skills)
        ? (agent!.skills as Array<{ name?: string; content?: string }>)
        : [];
      return skills.map((s) => ({ name: String(s?.name ?? ''), content: typeof s?.content === 'string' ? s.content : '' }));
    }),

  // The agent's markdown profile texts (Identity / User / Workspace rules / Tools).
  // Fetched once when the detail opens (long staleTime) — split out of byName so
  // they're not re-sent on its 30s/4s poll; shown in a collapsed FileList.
  coreTexts: machineProcedure
    .input(z.object({ name: z.string() }))
    .query(async ({ ctx, input }) => {
      return prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { identityText: true, userText: true, agentsText: true, toolsText: true },
      });
    }),

  // Just the file PATHS for each folder — NOT content. The detail sheet renders
  // folders collapsed and only needs the names up front; full content (asst's
  // memory corpus alone is ~600KB) is fetched per-folder by `folderContent` when
  // the user actually expands a folder. This query used to ship the whole ~600KB
  // on every detail open and, batched with cron.listForAgent, made the schedule
  // list wait behind it too.
  folders: machineProcedure
    .input(z.object({ name: z.string() }))
    .query(async ({ ctx, input }) => {
      const a = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { evolutionFiles: true, memoryFiles: true },
      });
      const paths = (files: unknown) =>
        Array.isArray(files)
          ? files.map((f) => ({ path: (f as { path?: string })?.path ?? '' })).filter((f) => f.path)
          : [];
      return { evolutionFiles: paths(a?.evolutionFiles), memoryFiles: paths(a?.memoryFiles) };
    }),

  // Full content for one folder (evolution | memory), fetched lazily when the
  // user expands that folder in the detail sheet.
  folderContent: machineProcedure
    .input(z.object({ name: z.string(), scope: z.enum(['evolution', 'memory']) }))
    .query(async ({ ctx, input }) => {
      const a = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { evolutionFiles: true, memoryFiles: true },
      });
      const col = input.scope === 'evolution' ? a?.evolutionFiles : a?.memoryFiles;
      return (Array.isArray(col) ? col : []) as Array<{ path: string; content: string }>;
    }),

  // ── Dashboard-driven agent lifecycle (round-trips through the gateway) ──────
  // The dashboard can't touch the gateway host's filesystem, so create/delete
  // are queued as AgentRequest rows; the gateway polls, scaffolds-from-template
  // / rm -rf's the dir, then acks. Mirrors the ChatSession restart round-trip.

  requestCreate: machineProcedure
    .input(z.object({
      name: z.string().trim().toLowerCase()
        .regex(/^[a-z][a-z0-9-]{0,30}$/, 'name must be lowercase: a letter then letters/digits/hyphens, ≤31 chars'),
      // Function/persona description. Optional — when omitted (or blank), we
      // fall back to a self-aware default below that tells the new agent to
      // infer its role from its name and how the user interacts with it.
      persona: z.string().trim().max(200).optional(),
      // Create from a marketplace template — the gateway scaffolds the base then
      // overlays the template's IDENTITY/AGENTS/skills.
      templateId: z.string().optional(),
      // Extra market skills to install into the new agent on top of the base
      // template defaults (slugs). Each writes its full tree via the same
      // AgentRequest(edit) path as market.installToAgent.
      skills: z.array(z.string()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // The base template's default skills (apps/cli/template/.claude/skills/);
      // a new agent's skills are auto-associated with the market on create. Keep
      // in sync if the template's default skill set changes.
      const DEFAULT_TEMPLATE_SKILLS = ['cron', 'loop', 'brave-search', 'browser-automation'];
      let includedSkills: string[] = [];
      const exists = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { id: true },
      });
      if (exists) throw new Error(`agent "${input.name}" already exists`);
      const pending = await prisma.agentRequest.findFirst({
        where: { machineId: ctx.machine.id, agentName: input.name, status: 'pending' },
        select: { id: true },
      });
      if (pending) throw new Error(`a request for "${input.name}" is already pending`);
      // Resolve a marketplace template (latest version) into the create request;
      // the gateway scaffolds the base then overlays these files.
      let templateContent: string | null = null;
      let templatePersona: string | null = null;
      if (input.templateId) {
        const tpl = await prisma.marketTemplate.findUnique({
          where: { id: input.templateId },
          include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
        });
        const ver = tpl?.versions[0];
        if (!tpl || !ver) throw new Error('template not found');
        templateContent = JSON.stringify({ templateFiles: ver.files });
        templatePersona = tpl.basePersona;
        includedSkills = ver.includedSkills ?? [];
      }
      const persona = input.persona?.trim() || templatePersona ||
        `An AI agent named ${input.name}. Infer your role and personality from your name and how the user interacts with you.`;
      // DB is the source of truth — the row appears in the list immediately.
      // `directory` stays null until the gateway scaffolds it at AGENTS_ROOT/<name>
      // and pushes a syncAgents update with the resolved path + initial content.
      // The AgentRequest is only the gateway's todo-list of filesystem actions.
      const created = await prisma.$transaction(async (tx) => {
        await tx.agent.create({
          data: { machineId: ctx.machine.id, name: input.name },
        });
        return tx.agentRequest.create({
          data: { machineId: ctx.machine.id, kind: 'create', agentName: input.name, persona, content: templateContent },
        });
      });
      // Auto-associate the new agent's market skills (default template skills +
      // a marketplace template's includedSkills) at the latest version — a
      // freshly-scaffolded agent gets the current template = latest published.
      // Best-effort; never blocks the create. (Existing agents were bound by the
      // one-time backfill; we no longer scan on every sync.)
      try {
        const wantSlugs = [...new Set([...DEFAULT_TEMPLATE_SKILLS, ...includedSkills])];
        const markets = await prisma.marketSkill.findMany({
          where: { slug: { in: wantSlugs } },
          select: { id: true, slug: true, latestVersion: true },
        });
        if (markets.length) {
          await prisma.agentSkillInstall.createMany({
            data: markets.map((m) => ({ machineId: ctx.machine.id, agentName: input.name, skillName: m.slug, marketSkillId: m.id, marketVersion: m.latestVersion })),
            skipDuplicates: true,
          });
        }
      } catch (e) {
        console.error('[requestCreate] skill auto-bind failed:', e);
      }
      // User-picked market skills (beyond the base/template defaults). Each
      // writes its whole tree via AgentRequest(edit, skill:<slug>) — the same
      // path as market.installToAgent — and binds for update-tracking. Ordered
      // AFTER the create request, so the gateway scaffolds first (FIFO), then
      // overlays these skills. Best-effort: a bad slug is skipped, never blocks.
      try {
        const SKILL_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
        const skip = new Set([...DEFAULT_TEMPLATE_SKILLS, ...includedSkills]);
        const pickSlugs = [...new Set(input.skills ?? [])].filter((s) => SKILL_RE.test(s) && !skip.has(s));
        if (pickSlugs.length) {
          const picked = await prisma.marketSkill.findMany({
            where: { slug: { in: pickSlugs } },
            include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
          });
          for (const m of picked) {
            const ver = m.versions[0];
            if (!ver || ver.content == null) continue; // bundles w/o a SKILL.md aren't installable
            await prisma.agentRequest.create({
              data: { machineId: ctx.machine.id, kind: 'edit', agentName: input.name, target: `skill:${m.slug}`, content: ver.content, refs: ver.refs ?? undefined },
            });
            await prisma.agentSkillInstall.upsert({
              where: { machineId_agentName_skillName: { machineId: ctx.machine.id, agentName: input.name, skillName: m.slug } },
              create: { machineId: ctx.machine.id, agentName: input.name, skillName: m.slug, marketSkillId: m.id, marketVersion: m.latestVersion },
              update: { marketSkillId: m.id, marketVersion: m.latestVersion },
            });
          }
        }
      } catch (e) {
        console.error('[requestCreate] market skill install failed:', e);
      }
      return created;
    }),

  // Import an existing agent dir into the dashboard. DB-leader model: we
  // create the Agent row with `directory` set immediately, and the gateway
  // picks it up on its next pull (api.listAgentDirectories) — at which point
  // it reads the markdowns from that path and pushes content via syncAgents.
  // No filesystem mutation on this path; the source folder stays where it is.
  requestImport: machineProcedure
    .input(z.object({
      // Absolute path on the gateway host. POSIX-style; the gateway is Mac/Linux.
      // 4 KB cap keeps the DB column reasonable.
      directory: z.string().trim()
        .min(2, 'directory required')
        .max(4096, 'path too long')
        .refine((p) => p.startsWith('/'), { message: 'must be an absolute path' })
        .refine((p) => !p.includes('\0'), { message: 'invalid characters' }),
    }))
    .mutation(async ({ ctx, input }) => {
      // Derive a slug from the basename — letters/digits/hyphens, ≤31 chars,
      // lowercase.
      const raw = input.directory.replace(/\/+$/, '').split('/').pop() || '';
      const slug = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31);
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(slug)) {
        throw new Error('could not derive a valid agent name from that path — basename must start with a letter and contain letters/digits/hyphens');
      }
      const exists = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: slug } },
        select: { id: true },
      });
      if (exists) throw new Error(`agent "${slug}" already exists`);
      // No AgentRequest needed — directory is set, gateway's next list-pull
      // sees it and reads the files.
      return prisma.agent.create({
        data: {
          machineId: ctx.machine.id,
          name: slug,
          directory: input.directory,
        },
      });
    }),

  // Soft-delete → recycle bin. Sets trashedAt right away (DB is leader, so the
  // agent drops out of the list immediately) and queues a 'delete' AgentRequest;
  // the gateway moves the dir into AGENTS_ROOT/.hermit-trash/. Imported agents'
  // source dirs are left untouched (DB-only). The row survives until purge.
  requestDelete: machineProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { id: true, trashedAt: true },
      });
      if (!agent) throw new Error('agent not found');
      if (agent.trashedAt) return agent; // already in the recycle bin
      await prisma.agent.update({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        data: { trashedAt: new Date() },
      });
      return prisma.agentRequest.create({
        data: { machineId: ctx.machine.id, kind: 'delete', agentName: input.name },
      });
    }),

  // Restore from the recycle bin: clear trashedAt and queue a 'restore' so the
  // gateway moves the dir back out of .hermit-trash/ to its home path.
  requestRestore: machineProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { id: true, trashedAt: true },
      });
      if (!agent) throw new Error('agent not found');
      if (!agent.trashedAt) return agent; // not trashed — nothing to restore
      await prisma.agent.update({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        data: { trashedAt: null },
      });
      return prisma.agentRequest.create({
        data: { machineId: ctx.machine.id, kind: 'restore', agentName: input.name },
      });
    }),

  // Permanently delete a trashed agent: queue a 'purge' so the gateway rm -rf's
  // the trash dir; ackRequest then drops the Agent row + its chat sessions. Only
  // valid once the agent is already in the recycle bin.
  requestPurge: machineProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { id: true, trashedAt: true },
      });
      if (!agent) throw new Error('agent not found');
      if (!agent.trashedAt) throw new Error('agent must be in the recycle bin before it can be permanently deleted');
      const pending = await prisma.agentRequest.findFirst({
        where: { machineId: ctx.machine.id, agentName: input.name, kind: 'purge', status: 'pending' },
      });
      if (pending) return pending;
      return prisma.agentRequest.create({
        data: { machineId: ctx.machine.id, kind: 'purge', agentName: input.name },
      });
    }),

  // Edit one of the agent's text files. `target` is an opaque slug — never a
  // raw path — that the gateway maps via an allow-list (see agent-lifecycle.ts).
  // Allowed: identity / user / agents / tools / evolution / claude / skill:<name>.
  requestEdit: machineProcedure
    .input(z.object({
      name: z.string(),
      // Flat targets, a skill's SKILL.md, OR any file under the workspace
      // evolution/ folder (evolution/<relpath>). memory/ is NOT editable — it's
      // Claude Code's auto-memory, read-only from the dashboard.
      target: z.string()
        .regex(/^(identity|user|agents|tools|evolution|claude|skill:[a-z0-9][a-z0-9-]{0,30}|evolution\/[A-Za-z0-9._/-]+)$/, 'invalid target')
        .refine((t) => !t.includes('..'), 'invalid path'),
      content: z.string().max(64 * 1024, 'content too large (>64KB)'),
    }))
    .mutation(async ({ ctx, input }) => {
      const agent = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { id: true },
      });
      if (!agent) throw new Error('agent not found');
      return prisma.agentRequest.create({
        data: {
          machineId: ctx.machine.id,
          kind: 'edit',
          agentName: input.name,
          target: input.target,
          content: input.content,
        },
      });
    }),

  // Designate (or clear) the machine's orchestrator ("义脑" / brain). At most one
  // per machine — promoting one clears the flag on any other. A plain DB flag;
  // the gateway reads it via chat.pollPending to gate the brain-only MCP tools.
  setOrchestrator: machineProcedure
    .input(z.object({ name: z.string(), value: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await prisma.agent.findUnique({
        where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
        select: { id: true, trashedAt: true },
      });
      if (!agent) throw new Error('agent not found');
      if (agent.trashedAt) throw new Error('cannot designate a trashed agent');
      await prisma.$transaction(async (tx) => {
        if (input.value) {
          // single-orchestrator invariant: clear any other on this machine first.
          await tx.agent.updateMany({
            where: { machineId: ctx.machine.id, isOrchestrator: true, name: { not: input.name } },
            data: { isOrchestrator: false },
          });
        }
        await tx.agent.update({
          where: { machineId_name: { machineId: ctx.machine.id, name: input.name } },
          data: { isOrchestrator: input.value },
        });
      });
      return { ok: true };
    }),

  // One-click "set up 义脑": scaffold a dedicated `brain` agent (orchestrator
  // persona overlaid into its IDENTITY) and flag it as the machine's orchestrator.
  // Returns the existing orchestrator if there already is one.
  setupBrain: machineProcedure.mutation(async ({ ctx }) => {
    const existing = await prisma.agent.findFirst({
      where: { machineId: ctx.machine.id, isOrchestrator: true, trashedAt: null },
      select: { name: true },
    });
    // Already have a brain → reconcile it (same path as ensureBrain) so the crab
    // button also converges an out-of-date brain instead of no-op'ing.
    if (existing) { await reconcileBrain(ctx.machine.id); return { name: existing.name, created: false }; }

    const name = 'brain';
    const clash = await prisma.agent.findUnique({
      where: { machineId_name: { machineId: ctx.machine.id, name } },
      select: { id: true },
    });
    if (clash) {
      throw new Error('an agent named "brain" already exists — open it and toggle "设为义脑" instead');
    }
    const pending = await prisma.agentRequest.findFirst({
      where: { machineId: ctx.machine.id, agentName: name, status: 'pending' },
      select: { id: true },
    });
    if (pending) return { name, created: false };

    // Overlay the orchestrator IDENTITY (write-once) + the managed `dreaming`
    // skill onto the base scaffold (keeps base AGENTS.md rules + default skills,
    // incl. cron). Stamp the template version so ensureBrain won't re-overlay.
    const templateContent = JSON.stringify({ templateFiles: BRAIN_CREATE_FILES });
    await prisma.$transaction(async (tx) => {
      await tx.agent.create({
        data: { machineId: ctx.machine.id, name, isOrchestrator: true, brainTemplateVersion: BRAIN_TEMPLATE_VERSION },
      });
      await tx.agentRequest.create({
        data: { machineId: ctx.machine.id, kind: 'create', agentName: name, persona: BRAIN_PERSONA, content: templateContent },
      });
      // Seed the daily "dream": consolidate memory + roster and prune context.
      // First run ~6h out (ensureBrain pulls it sooner once scaffolded); then
      // every 24h. The orchestrator's crons run WITH the brain MCP (cron-runner)
      // so the dream can roster().
      await tx.cron.create({
        data: {
          machineId: ctx.machine.id,
          agentName: name,
          title: BRAIN_DREAM_CRON.title,
          prompt: BRAIN_DREAM_PROMPT,
          intervalSec: BRAIN_DREAM_CRON.intervalSec,
          jitterSec: BRAIN_DREAM_CRON.jitterSec,
          nextFire: new Date(Date.now() + 6 * 60 * 60 * 1000),
        },
      });
    });
    return { name, created: true };
  }),

  // Idempotent brain convergence — called by the gateway on startup + a low-freq
  // tick. No-op when there's no orchestrator (Brain stays opt-in; only the crab
  // button's setupBrain creates one). Brings an out-of-date brain up to the
  // current template (the `dreaming` skill), ensures its Daily dream cron exists,
  // and triggers the first dream once so a fresh/updated brain self-populates its
  // memory in minutes instead of waiting up to 24h.
  ensureBrain: machineProcedure.mutation(async ({ ctx }) => {
    return reconcileBrain(ctx.machine.id);
  }),

  // Pending lifecycle requests — the agents page shows "creating…/deleting…".
  pendingRequests: machineProcedure.query(async ({ ctx }) => {
    return prisma.agentRequest.findMany({
      where: { machineId: ctx.machine.id, status: 'pending' },
      select: { id: true, kind: true, agentName: true, target: true, requestedAt: true },
    });
  }),

  // ── Gateway endpoints ──────────────────────────────────────────────────────
  // Gateway polls ~every 3s, scaffolds/deletes on disk, then acks.
  pollRequests: machineProcedure.query(async ({ ctx }) => {
    const reqs = await prisma.agentRequest.findMany({
      where: { machineId: ctx.machine.id, status: 'pending' },
      orderBy: { requestedAt: 'asc' },
    });
    if (reqs.length === 0) return [];
    // Join in each agent's directory so the gateway can scope filesystem ops
    // (delete only if path lives under AGENTS_ROOT). Old behaviour
    // hard-coded `path.join(AGENTS_ROOT, name)`; that's now wrong for imports
    // whose source lives outside AGENTS_ROOT.
    const names = [...new Set(reqs.map((r) => r.agentName))];
    const dirs = await prisma.agent.findMany({
      where: { machineId: ctx.machine.id, name: { in: names } },
      select: { name: true, directory: true },
    });
    const dirByName = new Map(dirs.map((d) => [d.name, d.directory]));
    return reqs.map((r) => ({ ...r, agentDirectory: dirByName.get(r.agentName) ?? null }));
  }),

  // Source-of-truth list for the gateway's content-refresh tick. The gateway
  // pulls (name, directory) from here, reads each directory's markdowns, and
  // pushes content back via /api/sync/agents. Rows with null directory are
  // freshly-created agents the gateway hasn't scaffolded yet — gateway skips
  // those until the matching AgentRequest(create) is processed.
  listForGateway: machineProcedure.query(async ({ ctx }) => {
    return prisma.agent.findMany({
      // Trashed agents are skipped — their dirs are in .hermit-trash, so there's
      // nothing for the gateway to read; their content stays frozen until restore.
      where: { machineId: ctx.machine.id, trashedAt: null },
      select: { name: true, directory: true, isOrchestrator: true },
      orderBy: { name: 'asc' },
    });
  }),

  ackRequest: machineProcedure
    .input(z.object({ id: z.string(), status: z.enum(['done', 'error']), error: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const r = await prisma.agentRequest.findUnique({ where: { id: input.id } });
      if (!r || r.machineId !== ctx.machine.id) throw new Error('not found');
      // A soft-delete ('delete') keeps the row — it's now trashed, and the gateway
      // just moved its dir into .hermit-trash. Only a 'purge' (permanent delete)
      // drops the Agent row + its chat sessions.
      if (r.kind === 'purge' && input.status === 'done') {
        await prisma.chatSession.deleteMany({ where: { machineId: ctx.machine.id, agentName: r.agentName } });
        await prisma.agent.deleteMany({ where: { machineId: ctx.machine.id, name: r.agentName } });
      }
      // On a failed create, drop the placeholder row we optimistically created
      // in requestCreate so the user isn't stuck with a permanently-empty agent.
      if (r.kind === 'create' && input.status === 'error') {
        await prisma.agent.deleteMany({ where: { machineId: ctx.machine.id, name: r.agentName, directory: null } });
      }
      // An 'overlay' (ensureBrain re-applying the brain's machine-managed files)
      // done → stamp the template version it carried, so ensureBrain stops
      // re-queuing it. Stamp only on success (a failed overlay leaves the version
      // behind → auto-retries next tick). Only ever advance the stamp.
      if (r.kind === 'overlay' && input.status === 'done') {
        let version = 0;
        try { version = Number(JSON.parse(r.content ?? '{}')?.version) || 0; } catch { /* ignore */ }
        if (version > 0) {
          await prisma.agent.updateMany({
            where: { machineId: ctx.machine.id, name: r.agentName, brainTemplateVersion: { lt: version } },
            data: { brainTemplateVersion: version },
          });
        }
      }
      return prisma.agentRequest.update({
        where: { id: input.id },
        data: { status: input.status, error: input.error ?? null, resolvedAt: new Date() },
      });
    }),
});
