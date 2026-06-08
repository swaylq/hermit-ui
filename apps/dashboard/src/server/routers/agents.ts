import { z } from 'zod';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

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
    return rows.map((r) => ({
      ...r,
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
        select: {
          id: true, name: true, directory: true, trashedAt: true, updatedAt: true,
          identityText: true, userText: true, agentsText: true, toolsText: true,
          evolutionLessons: true, skillNames: true, skills: true, memorySummary: true,
          metadataAt: true,
        },
      });
      if (!agent) return null;
      // Sessions are queried separately by the detail sheet via
      // chat.listSessions({ agentName }), so no need to join here.
      return { agent };
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
    }))
    .mutation(async ({ ctx, input }) => {
      // The base template's default skills (apps/cli/template/.claude/skills/);
      // a new agent's skills are auto-associated with the market on create. Keep
      // in sync if the template's default skill set changes.
      const DEFAULT_TEMPLATE_SKILLS = ['cron', 'loop', 'brave-search', 'browser-automation', 'reshape-agent', 'update-hermit'];
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
      select: { name: true, directory: true },
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
      return prisma.agentRequest.update({
        where: { id: input.id },
        data: { status: input.status, error: input.error ?? null, resolvedAt: new Date() },
      });
    }),
});
