# Knowledge Base — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. This repo has **no unit-test harness** — "verify" means `tsc --noEmit` + `next build` + runtime checks, per the marketplace/message-queue plan convention.

**Goal:** Per-machine knowledge bases (markdown docs) attached per-agent like skills, with skill-native progressive loading, plus a Brain-dream intro auto-refresh.

**Architecture:** DB is the source of truth. Each attached KB is materialized by the gateway as a Claude Code skill under `<agent_dir>/.claude/skills/kb-<slug>/` (intro → SKILL.md `description`; docs → `docs/*.md`; `hermit_kind: knowledge` marks it so skill collectors skip it). tRPC mutations enqueue `KnowledgeBaseRequest` rows; the gateway polls, writes disk, acks. The Brain refreshes intros during its daily dream via 3 new brain-only MCP tools.

**Tech Stack:** Next.js 16 App Router + tRPC + Prisma/Postgres (apps/dashboard); Node gateway (apps/gateway); Claude Code skills.

**Spec:** `docs/knowledge-base-design.md`. **Branch:** `knowledge-base` → merge to `main` at the end. **Deploy:** `git push origin main` → `ssh ubuntu@45.89.234.110 -- '~/hermit-ui/scripts/vps-deploy.sh'` (prisma migrate deploy + next build + restart); gateway changes need per-machine restart.

---

## File Structure

**Create**
- `apps/dashboard/prisma/migrations/<ts>_knowledge_base/migration.sql` — additive migration.
- `apps/dashboard/src/server/routers/knowledge.ts` — the router (library CRUD + attach + gateway poll/ack).
- `apps/dashboard/src/app/knowledge/page.tsx` — library list.
- `apps/dashboard/src/app/knowledge/[slug]/page.tsx` — KB editor (name/intro + docs master-detail).
- `apps/dashboard/src/components/attach-knowledge-dialog.tsx` — machine-KB picker for agent detail.
- `apps/gateway/src/knowledge.ts` — materializer + tick + startup reconcile.

**Modify**
- `apps/dashboard/prisma/schema.prisma` — 4 models + `Machine.knowledgeBases`.
- `apps/dashboard/src/server/routers/_app.ts` — mount `knowledge`.
- `apps/dashboard/src/components/app-sidebar.tsx` — NAV entry + CTA branch.
- `apps/dashboard/src/components/agent-detail-sheet.tsx` — `KnowledgeBases` section.
- `apps/gateway/src/index.ts` — wire tick + startup reconcile.
- `apps/gateway/src/global-skills.ts` — `parseFrontmatter` reads `hermit_kind`; `collectGlobalSkills` skips knowledge.
- `apps/gateway/src/collect/agents.ts` — `listSkills`/`listSkillDocs` skip knowledge.
- `apps/gateway/src/mcp-stub.cjs` — `kb_list`/`kb_read_docs`/`kb_set_intro` brain tools.
- `apps/dashboard/src/server/brain-template.ts` — dreaming-skill KB step + `BRAIN_TEMPLATE_VERSION` bump.

---

## Phase 1 — DB + tRPC router

### Task 1.1: Prisma schema + migration
**Files:** Modify `apps/dashboard/prisma/schema.prisma`; Create `apps/dashboard/prisma/migrations/<ts>_knowledge_base/migration.sql`.

- [ ] Add `KnowledgeBase`, `KnowledgeDoc`, `AgentKnowledgeBase`, `KnowledgeBaseRequest` models + `Machine.knowledgeBases KnowledgeBase[]` back-relation (exact columns in spec §2, incl. `autoIntro`, `introUpdatedAt`, `contentUpdatedAt`).
- [ ] Hand-write an **additive** migration (CREATE TABLE ×4 + indexes/uniques); match the style/`cuid` of existing migrations. Confirm column names/types match the models.
- [ ] Verify: `npx prisma validate` and `npx prisma generate` succeed; `tsc --noEmit` clean.

### Task 1.2: `knowledge` router + mount
**Files:** Create `apps/dashboard/src/server/routers/knowledge.ts`; Modify `_app.ts`.

- [ ] Implement procedures per spec §5: `listBases`, `getBase`, `docContent`, `baseDocs`, `createBase`, `updateBase`, `deleteBase`, `createDoc`, `updateDoc`, `deleteDoc`, `reorderDocs`, `setIntro`, `attachToAgent`, `detachFromAgent`, `listAgentBases`, `pollRequests`, `ackRequest`. All `machineProcedure` (`ctx.machine.id`). Mirror `skills.ts`/`globalMemory.ts` shapes.
- [ ] Slug/filename helpers (server-side slugify + collision suffix); `filename` stable across title edits.
- [ ] Fan-out helper `enqueueMaterialize(baseId)`: for each `AgentKnowledgeBase` of the base, create a `KnowledgeBaseRequest{kind:'materialize', payload:{name,intro,docs}}`; `enqueueRemove(agentName, slug)`. Called by every content mutation + attach/detach/delete.
- [ ] `updateBase` intro/autoIntro rule (spec §5): explicit `autoIntro` wins; else changed `intro` ⇒ `autoIntro=false`; setting intro bumps `introUpdatedAt`. Doc mutations bump `contentUpdatedAt`. `setIntro` preserves `autoIntro`.
- [ ] Mount `knowledge: knowledgeRouter` in `_app.ts`.
- [ ] Verify: `tsc --noEmit` clean.

**Commit:** `feat(knowledge): prisma models + tRPC router`.

---

## Phase 2 — Gateway materialization

### Task 2.1: `knowledge.ts` materializer + tick + reconcile
**Files:** Create `apps/gateway/src/knowledge.ts`.

- [ ] `renderSkillMd(name, intro, docs)` → SKILL.md text (frontmatter `name`/`description`(intro || `Knowledge base: <name>`)/`hermit_kind: knowledge` + body doc index) per spec §3.
- [ ] `applyKnowledgeRequest(req)`: `materialize` writes `<agentDir>/.claude/skills/kb-<slug>/SKILL.md` + `docs/<filename>.md` (reuse the `..`-guarded recursive writer from `global-skills.ts`), prunes doc files not in payload; `remove` `rm -rf` the dir. Resolve `agentDir` from DB (`api.listAgentDirectories`/`Agent.directory`) — do not readdir AGENTS_ROOT.
- [ ] `knowledgeRequestTick()`: poll `knowledge.pollRequests` → apply → `knowledge.ackRequest`.
- [ ] `reconcileKnowledgeOnStartup()`: for each agent, materialize attached KBs + delete stale `kb-*` dirs.
- [ ] Verify: gateway `tsc --noEmit` (or `npm run build`) clean.

### Task 2.2: wire into gateway loop
**Files:** Modify `apps/gateway/src/index.ts`.

- [ ] Call `reconcileKnowledgeOnStartup()` once at startup; `loop(() => safe('knowledge', knowledgeRequestTick), 3_000)` next to the global-skill request tick.
- [ ] Verify: gateway build clean.

### Task 2.3: skill-collector exclusion
**Files:** Modify `apps/gateway/src/global-skills.ts`, `apps/gateway/src/collect/agents.ts`.

- [ ] `parseFrontmatter` also returns `hermit_kind`; `collectGlobalSkills` skips dirs where `hermit_kind === 'knowledge'`.
- [ ] `listSkills`/`listSkillDocs` skip knowledge dirs (read the SKILL.md frontmatter marker).
- [ ] Verify: gateway build clean; existing skills still collected.

**Commit:** `feat(knowledge): gateway materialization + collector exclusion`.

---

## Phase 3 — Dashboard UI

### Task 3.1: sidebar entry
**Files:** Modify `apps/dashboard/src/components/app-sidebar.tsx`.

- [ ] `NAV`: add `{ href: '/knowledge', label: 'Knowledge', icon: BookOpen }` after Cron; import `BookOpen`.
- [ ] CTA branch: on `/knowledge` → "New knowledge base" (`/knowledge?new=1`).
- [ ] Verify: `tsc` + visual (nav item shows).

### Task 3.2: `/knowledge` library list
**Files:** Create `apps/dashboard/src/app/knowledge/page.tsx`.

- [ ] KB cards (name, intro, doc count, attached-agent count) from `knowledge.listBases`; "New knowledge base" (create → route to `/knowledge/<slug>`); handle `?new=1`. English UI.
- [ ] Verify: `tsc` + `next build`.

### Task 3.3: `/knowledge/[slug]` editor
**Files:** Create `apps/dashboard/src/app/knowledge/[slug]/page.tsx`.

- [ ] Header: name edit + delete-KB. Intro editor with Auto/Manual indicator + toggle (spec §7); save via `updateBase`.
- [ ] Docs master-detail: list (add/rename/delete/reorder via `createDoc`/`updateDoc`/`deleteDoc`/`reorderDocs`) + markdown editor (`docContent` load, `updateDoc` save). Reuse existing markdown/file editor patterns.
- [ ] Verify: `tsc` + `next build`.

### Task 3.4: agent-detail section + attach dialog
**Files:** Modify `apps/dashboard/src/components/agent-detail-sheet.tsx`; Create `apps/dashboard/src/components/attach-knowledge-dialog.tsx`.

- [ ] `KnowledgeBases` section in `AgentDetailContent` detail tab after `SkillsAndTasks`: list `knowledge.listAgentBases` (name+intro+docCount) + detach; "Attach knowledge base" opens `AttachKnowledgeDialog` (picker of `listBases`, calls `attachToAgent`). Mirror `SkillsAndTasks`/`InstallSkillDialog`.
- [ ] Verify: `tsc` + `next build`.

**Commit:** `feat(knowledge): dashboard UI (library, editor, agent-detail)`.

---

## Phase 4 — Brain dream intro refresh

### Task 4.1: brain MCP tools
**Files:** Modify `apps/gateway/src/mcp-stub.cjs`.

- [ ] Add to `BRAIN_TOOLS`: `kb_list` (`{}`), `kb_read_docs` (`{baseId}`), `kb_set_intro` (`{baseId, intro}`) with descriptions + inputSchema.
- [ ] Add handlers in `dispatchBrainTool`: `kb_list`→`trpcQuery('knowledge.listBases')`; `kb_read_docs`→`trpcQuery('knowledge.baseDocs',{baseId})`; `kb_set_intro`→`trpcMutate('knowledge.setIntro',{id:baseId,intro})`.
- [ ] Verify: node parses the file; gateway boots with `HERMIT_BRAIN=1` exposing the tools.

### Task 4.2: dreaming skill step + version bump
**Files:** Modify `apps/dashboard/src/server/brain-template.ts`.

- [ ] Add the "Refresh knowledge-base intros" step to `BRAIN_DREAMING_SKILL` (spec §8 wording: iterate `kb_list`, for `autoIntro && contentUpdatedAt>introUpdatedAt` → `kb_read_docs` → write 1–3-sentence intro → `kb_set_intro`; skip empty).
- [ ] Bump `BRAIN_TEMPLATE_VERSION` 2 → 3 (re-overlays the dreaming skill). Optionally list the kb_* tools in `BRAIN_IDENTITY` tool list (new brains only).
- [ ] Verify: `tsc` + `next build`.

**Commit:** `feat(knowledge): brain dream intro auto-refresh`.

---

## Phase 5 — Integrate, deploy, verify, rollout

- [ ] Final `tsc --noEmit` (dashboard + gateway) + `next build` clean on the branch.
- [ ] Merge `knowledge-base` → `main` (`git fetch origin main`; verify ancestry; merge; push).
- [ ] Deploy: `ssh ubuntu@45.89.234.110 -- '~/hermit-ui/scripts/vps-deploy.sh'`; confirm HTTP 200 + migration applied.
- [ ] Restart the **Mac** gateway (pm2 `hermit-ui-gateway`) so the new tick/tools/collector-exclusion load.
- [ ] Runtime verification (spec §10): create KB+doc → attach to a test agent → confirm on-disk `kb-<slug>/SKILL.md`+`docs/*.md` (+ `hermit_kind`), agent sees it as a skill w/ intro description + reads a doc, edit re-materializes, detach removes dir, KB **absent** from Global Skills; Brain "Dream now" refreshes an `autoIntro` KB's intro, Manual untouched.
- [ ] Fleet rollout: git pull + restart gateway on both macminis (sway003 needs `zsh -lc` for pm2 PATH).

**Commit/rollout notes:** shared tree → `git fetch origin main` before merge; only `git add` named files.

---

## Self-review notes
- **Spec coverage:** §1 scope → all phases; §2 model → 1.1; §3 disk → 2.1; §4 sync → 2.1/2.2; §5 router → 1.2; §6 exclusion → 2.3; §7 UI → 3.1–3.4; §8 dream → 4.1/4.2; §9 edge → 1.2/2.1; §10 verify → Phase 5.
- **Type consistency:** procedure names + payload shape (`{name,intro,docs:[{filename,title,content}]}`) identical across router (1.2), gateway (2.1), and brain tools (4.1).
