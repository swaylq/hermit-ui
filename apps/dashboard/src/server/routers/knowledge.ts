import { z } from 'zod';
import { router, gatewayProcedure, machineProcedure } from '../trpc';
import { prisma } from '../db';

// Per-machine knowledge bases: a library of markdown docs attached to agents like
// skills. DB is the source of truth; every content/attach change enqueues a
// KnowledgeBaseRequest that the gateway materializes as a Claude Code skill under
// <agent>/.claude/skills/kb-<slug>/ (intro → SKILL.md description, docs read on
// demand). See docs/knowledge-base-design.md. All machineProcedure (ctx.machine.id).

const MAX_NAME = 100;
const MAX_INTRO = 4 * 1024; // the always-loaded summary — keep it small
const MAX_TITLE = 200;
const MAX_DOC = 512 * 1024; // 512 KB markdown per doc

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'kb'
  );
}

async function uniqueSlug(machineId: string, name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; ; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await prisma.knowledgeBase.findUnique({
      where: { machineId_slug: { machineId, slug } },
      select: { id: true },
    });
    if (!existing) return slug;
  }
}

async function uniqueFilename(knowledgeBaseId: string, title: string): Promise<string> {
  const base = slugify(title);
  for (let i = 0; ; i++) {
    const filename = `${i === 0 ? base : `${base}-${i + 1}`}.md`;
    const existing = await prisma.knowledgeDoc.findUnique({
      where: { knowledgeBaseId_filename: { knowledgeBaseId, filename } },
      select: { id: true },
    });
    if (!existing) return filename;
  }
}

// Snapshot the KB and enqueue a `materialize` request for every agent it's attached
// to. Called by every content mutation (intro/doc change) + attach. The gateway
// writes <agent>/.claude/skills/kb-<slug>/ from the payload snapshot (idempotent).
async function enqueueMaterialize(machineId: string, knowledgeBaseId: string): Promise<void> {
  const base = await prisma.knowledgeBase.findUnique({
    where: { id: knowledgeBaseId },
    select: {
      machineId: true,
      slug: true,
      name: true,
      intro: true,
      docs: { orderBy: { sortOrder: 'asc' }, select: { filename: true, title: true, content: true } },
      attachments: { select: { agentName: true } },
    },
  });
  if (!base || base.machineId !== machineId || base.attachments.length === 0) return;
  const payload = { name: base.name, intro: base.intro, docs: base.docs };
  await prisma.$transaction(
    base.attachments.map((a) =>
      prisma.knowledgeBaseRequest.create({
        data: { machineId, agentName: a.agentName, slug: base.slug, kind: 'materialize', payload },
      }),
    ),
  );
}

async function enqueueRemove(machineId: string, agentName: string, slug: string): Promise<void> {
  await prisma.knowledgeBaseRequest.create({
    data: { machineId, agentName, slug, kind: 'remove' },
  });
}

export const knowledgeRouter = router({
  // ── Library ────────────────────────────────────────────────────────────────
  listBases: machineProcedure.query(async ({ ctx }) => {
    const bases = await prisma.knowledgeBase.findMany({
      where: { machineId: ctx.machine.id },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        slug: true,
        name: true,
        intro: true,
        autoIntro: true,
        introUpdatedAt: true,
        contentUpdatedAt: true,
        _count: { select: { docs: true, attachments: true } },
      },
    });
    return bases.map((b) => ({
      id: b.id,
      slug: b.slug,
      name: b.name,
      intro: b.intro,
      autoIntro: b.autoIntro,
      introUpdatedAt: b.introUpdatedAt,
      contentUpdatedAt: b.contentUpdatedAt,
      docCount: b._count.docs,
      attachedAgentCount: b._count.attachments,
    }));
  }),

  getBase: machineProcedure.input(z.object({ slug: z.string() })).query(async ({ ctx, input }) => {
    return prisma.knowledgeBase.findUnique({
      where: { machineId_slug: { machineId: ctx.machine.id, slug: input.slug } },
      select: {
        id: true,
        slug: true,
        name: true,
        intro: true,
        autoIntro: true,
        introUpdatedAt: true,
        contentUpdatedAt: true,
        docs: {
          orderBy: { sortOrder: 'asc' },
          select: { id: true, title: true, filename: true, sortOrder: true, updatedAt: true },
        },
      },
    });
  }),

  // One doc's markdown — split from getBase so the metadata view stays small.
  docContent: machineProcedure.input(z.object({ docId: z.string() })).query(async ({ ctx, input }) => {
    const doc = await prisma.knowledgeDoc.findUnique({
      where: { id: input.docId },
      select: { id: true, title: true, content: true, knowledgeBase: { select: { machineId: true } } },
    });
    if (!doc || doc.knowledgeBase.machineId !== ctx.machine.id) return null;
    return { id: doc.id, title: doc.title, content: doc.content };
  }),

  // All docs WITH content — single call for the Brain's kb_read_docs and the
  // knowledge-base-editor skill's `read` (which needs doc ids to edit/delete).
  baseDocs: machineProcedure.input(z.object({ baseId: z.string() })).query(async ({ ctx, input }) => {
    const base = await prisma.knowledgeBase.findUnique({
      where: { id: input.baseId },
      select: {
        machineId: true,
        name: true,
        intro: true,
        docs: { orderBy: { sortOrder: 'asc' }, select: { id: true, title: true, filename: true, content: true } },
      },
    });
    if (!base || base.machineId !== ctx.machine.id) return null;
    return { id: input.baseId, name: base.name, intro: base.intro, docs: base.docs };
  }),

  createBase: machineProcedure
    .input(z.object({ name: z.string().trim().min(1).max(MAX_NAME), intro: z.string().max(MAX_INTRO).optional() }))
    .mutation(async ({ ctx, input }) => {
      const slug = await uniqueSlug(ctx.machine.id, input.name);
      return prisma.knowledgeBase.create({
        data: { machineId: ctx.machine.id, slug, name: input.name, intro: input.intro ?? '' },
        select: { id: true, slug: true },
      });
    }),

  updateBase: machineProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().trim().min(1).max(MAX_NAME).optional(),
        intro: z.string().max(MAX_INTRO).optional(),
        autoIntro: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const base = await prisma.knowledgeBase.findUnique({
        where: { id: input.id },
        select: { machineId: true, intro: true },
      });
      if (!base || base.machineId !== ctx.machine.id) throw new Error('knowledge base not found');
      const introChanged = input.intro !== undefined && input.intro !== base.intro;
      const data: { name?: string; intro?: string; introUpdatedAt?: Date; autoIntro?: boolean } = {};
      if (input.name !== undefined) data.name = input.name;
      if (introChanged) {
        data.intro = input.intro;
        data.introUpdatedAt = new Date();
        // Manual intro edit → user takes over; the Brain stops rewriting it, unless
        // this same call explicitly sets autoIntro.
        if (input.autoIntro === undefined) data.autoIntro = false;
      }
      if (input.autoIntro !== undefined) data.autoIntro = input.autoIntro;
      await prisma.knowledgeBase.update({ where: { id: input.id }, data });
      if (input.name !== undefined || introChanged) await enqueueMaterialize(ctx.machine.id, input.id);
      return { ok: true };
    }),

  deleteBase: machineProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const base = await prisma.knowledgeBase.findUnique({
      where: { id: input.id },
      select: { machineId: true, slug: true, attachments: { select: { agentName: true } } },
    });
    if (!base || base.machineId !== ctx.machine.id) throw new Error('knowledge base not found');
    for (const a of base.attachments) await enqueueRemove(ctx.machine.id, a.agentName, base.slug);
    await prisma.knowledgeBase.delete({ where: { id: input.id } });
    return { ok: true };
  }),

  // ── Documents ────────────────────────────────────────────────────────────
  createDoc: machineProcedure
    .input(z.object({ baseId: z.string(), title: z.string().trim().min(1).max(MAX_TITLE), content: z.string().max(MAX_DOC).optional() }))
    .mutation(async ({ ctx, input }) => {
      const base = await prisma.knowledgeBase.findUnique({ where: { id: input.baseId }, select: { machineId: true } });
      if (!base || base.machineId !== ctx.machine.id) throw new Error('knowledge base not found');
      const filename = await uniqueFilename(input.baseId, input.title);
      const agg = await prisma.knowledgeDoc.aggregate({ where: { knowledgeBaseId: input.baseId }, _max: { sortOrder: true } });
      const doc = await prisma.knowledgeDoc.create({
        data: {
          knowledgeBaseId: input.baseId,
          title: input.title,
          filename,
          content: input.content ?? '',
          sortOrder: (agg._max.sortOrder ?? -1) + 1,
        },
        select: { id: true },
      });
      await prisma.knowledgeBase.update({ where: { id: input.baseId }, data: { contentUpdatedAt: new Date() } });
      await enqueueMaterialize(ctx.machine.id, input.baseId);
      return doc;
    }),

  updateDoc: machineProcedure
    .input(z.object({ id: z.string(), title: z.string().trim().min(1).max(MAX_TITLE).optional(), content: z.string().max(MAX_DOC).optional() }))
    .mutation(async ({ ctx, input }) => {
      const doc = await prisma.knowledgeDoc.findUnique({
        where: { id: input.id },
        select: { knowledgeBaseId: true, knowledgeBase: { select: { machineId: true } } },
      });
      if (!doc || doc.knowledgeBase.machineId !== ctx.machine.id) throw new Error('document not found');
      const data: { title?: string; content?: string } = {};
      if (input.title !== undefined) data.title = input.title; // filename stays stable across title edits
      if (input.content !== undefined) data.content = input.content;
      await prisma.knowledgeDoc.update({ where: { id: input.id }, data });
      await prisma.knowledgeBase.update({ where: { id: doc.knowledgeBaseId }, data: { contentUpdatedAt: new Date() } });
      await enqueueMaterialize(ctx.machine.id, doc.knowledgeBaseId);
      return { ok: true };
    }),

  deleteDoc: machineProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const doc = await prisma.knowledgeDoc.findUnique({
      where: { id: input.id },
      select: { knowledgeBaseId: true, knowledgeBase: { select: { machineId: true } } },
    });
    if (!doc || doc.knowledgeBase.machineId !== ctx.machine.id) throw new Error('document not found');
    await prisma.knowledgeDoc.delete({ where: { id: input.id } });
    await prisma.knowledgeBase.update({ where: { id: doc.knowledgeBaseId }, data: { contentUpdatedAt: new Date() } });
    await enqueueMaterialize(ctx.machine.id, doc.knowledgeBaseId);
    return { ok: true };
  }),

  reorderDocs: machineProcedure
    .input(z.object({ baseId: z.string(), orderedIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const base = await prisma.knowledgeBase.findUnique({ where: { id: input.baseId }, select: { machineId: true } });
      if (!base || base.machineId !== ctx.machine.id) throw new Error('knowledge base not found');
      await prisma.$transaction(
        input.orderedIds.map((id, i) =>
          prisma.knowledgeDoc.updateMany({ where: { id, knowledgeBaseId: input.baseId }, data: { sortOrder: i } }),
        ),
      );
      await prisma.knowledgeBase.update({ where: { id: input.baseId }, data: { contentUpdatedAt: new Date() } });
      await enqueueMaterialize(ctx.machine.id, input.baseId);
      return { ok: true };
    }),

  // Brain-facing: write intro, PRESERVE autoIntro (distinct from the user's updateBase).
  setIntro: machineProcedure
    .input(z.object({ id: z.string(), intro: z.string().max(MAX_INTRO) }))
    .mutation(async ({ ctx, input }) => {
      const base = await prisma.knowledgeBase.findUnique({ where: { id: input.id }, select: { machineId: true } });
      if (!base || base.machineId !== ctx.machine.id) throw new Error('knowledge base not found');
      await prisma.knowledgeBase.update({
        where: { id: input.id },
        data: { intro: input.intro, introUpdatedAt: new Date() },
      });
      await enqueueMaterialize(ctx.machine.id, input.id);
      return { ok: true };
    }),

  // ── Attach / detach (per-agent) ──────────────────────────────────────────
  attachToAgent: machineProcedure
    .input(z.object({ agentName: z.string(), baseId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const base = await prisma.knowledgeBase.findUnique({ where: { id: input.baseId }, select: { machineId: true } });
      if (!base || base.machineId !== ctx.machine.id) throw new Error('knowledge base not found');
      await prisma.agentKnowledgeBase.upsert({
        where: {
          machineId_agentName_knowledgeBaseId: {
            machineId: ctx.machine.id,
            agentName: input.agentName,
            knowledgeBaseId: input.baseId,
          },
        },
        create: { machineId: ctx.machine.id, agentName: input.agentName, knowledgeBaseId: input.baseId },
        update: {},
      });
      await enqueueMaterialize(ctx.machine.id, input.baseId); // writes for all attached, incl. the new agent
      return { ok: true };
    }),

  detachFromAgent: machineProcedure
    .input(z.object({ agentName: z.string(), baseId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const base = await prisma.knowledgeBase.findUnique({ where: { id: input.baseId }, select: { machineId: true, slug: true } });
      if (!base || base.machineId !== ctx.machine.id) throw new Error('knowledge base not found');
      await prisma.agentKnowledgeBase.deleteMany({
        where: { machineId: ctx.machine.id, agentName: input.agentName, knowledgeBaseId: input.baseId },
      });
      await enqueueRemove(ctx.machine.id, input.agentName, base.slug);
      return { ok: true };
    }),

  listAgentBases: machineProcedure.input(z.object({ agentName: z.string() })).query(async ({ ctx, input }) => {
    const rows = await prisma.agentKnowledgeBase.findMany({
      where: { machineId: ctx.machine.id, agentName: input.agentName },
      orderBy: { createdAt: 'asc' },
      select: {
        knowledgeBase: { select: { id: true, slug: true, name: true, intro: true, _count: { select: { docs: true } } } },
      },
    });
    return rows.map((r) => ({
      id: r.knowledgeBase.id,
      slug: r.knowledgeBase.slug,
      name: r.knowledgeBase.name,
      intro: r.knowledgeBase.intro,
      docCount: r.knowledgeBase._count.docs,
    }));
  }),

  // ── Gateway endpoints ──────────────────────────────────────────────────────
  // Lightweight manifest for the gateway's startup reconcile: every attached KB on
  // this machine + its `contentUpdatedAt`, WITHOUT the docs' markdown. The gateway
  // diffs this against an on-disk `.materialized-at` marker per kb-<slug> dir and
  // only fetches + rewrites the CHANGED bases (materializationForMachine below),
  // instead of re-shipping every base's full content on every restart. (P3-1)
  materializationManifestForMachine: machineProcedure.query(async ({ ctx }) => {
    const rows = await prisma.agentKnowledgeBase.findMany({
      where: { machineId: ctx.machine.id },
      select: {
        agentName: true,
        knowledgeBase: { select: { slug: true, name: true, contentUpdatedAt: true } },
      },
    });
    const names = [...new Set(rows.map((r) => r.agentName))];
    const agents = names.length
      ? await prisma.agent.findMany({ where: { machineId: ctx.machine.id, name: { in: names } }, select: { name: true, directory: true } })
      : [];
    const dirByName = new Map(agents.map((a) => [a.name, a.directory]));
    return rows.map((r) => ({
      agentName: r.agentName,
      agentDirectory: dirByName.get(r.agentName) ?? null,
      slug: r.knowledgeBase.slug,
      name: r.knowledgeBase.name,
      contentUpdatedAt: r.knowledgeBase.contentUpdatedAt.toISOString(),
    }));
  }),

  // Full attached-KB snapshot for this machine (docs' markdown included), joined
  // with the agent directory. `input.items` (optional) restricts it to a specific
  // set of (agentName, slug) attachments — the changed subset the gateway asks for
  // after diffing the manifest; omit it (null) for the whole set. Each item carries
  // `contentUpdatedAt` so the gateway can stamp its per-dir marker after writing.
  materializationForMachine: machineProcedure
    .input(z.object({ items: z.array(z.object({ agentName: z.string(), slug: z.string() })) }).nullish())
    .query(async ({ ctx, input }) => {
      const wanted = input?.items ?? null;
      if (wanted && wanted.length === 0) return [];
      const rows = await prisma.agentKnowledgeBase.findMany({
        where: wanted
          ? { machineId: ctx.machine.id, OR: wanted.map((i) => ({ agentName: i.agentName, knowledgeBase: { slug: i.slug } })) }
          : { machineId: ctx.machine.id },
        select: {
          agentName: true,
          knowledgeBase: {
            select: {
              slug: true,
              name: true,
              intro: true,
              contentUpdatedAt: true,
              docs: { orderBy: { sortOrder: 'asc' }, select: { filename: true, title: true, content: true } },
            },
          },
        },
      });
      const names = [...new Set(rows.map((r) => r.agentName))];
      const agents = names.length
        ? await prisma.agent.findMany({ where: { machineId: ctx.machine.id, name: { in: names } }, select: { name: true, directory: true } })
        : [];
      const dirByName = new Map(agents.map((a) => [a.name, a.directory]));
      return rows.map((r) => ({
        agentName: r.agentName,
        agentDirectory: dirByName.get(r.agentName) ?? null,
        slug: r.knowledgeBase.slug,
        name: r.knowledgeBase.name,
        intro: r.knowledgeBase.intro,
        contentUpdatedAt: r.knowledgeBase.contentUpdatedAt.toISOString(),
        docs: r.knowledgeBase.docs,
      }));
    }),

  // Pending materialize/remove requests, joined with each agent's on-disk directory
  // (like chat.pollPending) so the gateway knows where to write. Gateway polls ~3s.
  pollRequests: gatewayProcedure.query(async ({ ctx }) => {
    const reqs = await prisma.knowledgeBaseRequest.findMany({
      where: { machineId: ctx.machine.id, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    if (reqs.length === 0) return [];
    const names = [...new Set(reqs.map((r) => r.agentName))];
    const agents = await prisma.agent.findMany({
      where: { machineId: ctx.machine.id, name: { in: names } },
      select: { name: true, directory: true },
    });
    const dirByName = new Map(agents.map((a) => [a.name, a.directory]));
    return reqs.map((r) => ({
      id: r.id,
      agentName: r.agentName,
      slug: r.slug,
      kind: r.kind,
      payload: r.payload,
      agentDirectory: dirByName.get(r.agentName) ?? null,
    }));
  }),

  ackRequest: gatewayProcedure
    .input(z.object({ id: z.string(), status: z.enum(['done', 'error']), error: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const r = await prisma.knowledgeBaseRequest.findUnique({ where: { id: input.id } });
      if (!r || r.machineId !== ctx.machine.id) throw new Error('not found');
      return prisma.knowledgeBaseRequest.update({
        where: { id: input.id },
        data: { status: input.status, error: input.error ?? null, resolvedAt: new Date() },
      });
    }),
});
