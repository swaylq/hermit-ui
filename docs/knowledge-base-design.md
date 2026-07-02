# Knowledge Base — Design

**Goal:** A per-machine library of knowledge bases (each a set of markdown documents) that agents attach like skills, loaded into an agent's Claude Code context **progressively** — only the KB's one-line intro is ever resident; the documents are read on demand. The Brain keeps each intro current by summarizing the docs during its daily dream.

**Status:** Approved design (2026-07-02). Implementation plan → `docs/knowledge-base-plan.md`.

---

## 1. Concept & scope

- A **KnowledgeBase (KB)** belongs to a machine. It has a `name`, a short `intro` (the always-loaded summary — "what's inside + when to consult it"), and many **KnowledgeDoc** documents (markdown).
- The **machine's KB library** is managed from a new top-level `/knowledge` area (sidebar entry, in the slot Settings used to occupy). Full CRUD of KBs and their docs.
- Agents **attach** a subset of the machine's KBs from their detail view — exactly like the skills install/uninstall model (machine library + per-agent attach).
- **Storage model:** the **database is the source of truth** (you author docs in the dashboard). The gateway **materializes** each *attached* KB onto disk for that agent. Editing a doc in the library re-materializes it for every agent that has it attached. Agents do **not** write back to a KB (curated, read-only to agents).
- **Progressive loading (chosen approach — "A"):** each attached KB is materialized as a **Claude Code skill** (`<agent_dir>/.claude/skills/kb-<slug>/`). Claude Code's native skill loading is the progressive mechanism: the SKILL.md `description` (= the KB intro) is always resident; the SKILL.md body (a document index) loads only when the skill is triggered; the individual doc files load only when the agent `Read`s them. This is the most literal "like skills" and reuses the entire skill disk pipeline.

### Out of scope (v1)

- Machine-wide attach (a KB auto-applied to *all* agents). v1 is per-agent attach only.
- A KB marketplace / cross-machine sharing.
- Per-agent divergence of KB content (edits are library-global; every attached agent gets the same docs).
- Semantic / embedding search. The agent "queries" a KB with its normal `Read`/`Grep` on the materialized doc files.
- Agent write-back into a KB.
- A "Regenerate intro now" button (dispatch the Brain on demand). Deferred to v1.1.

---

## 2. Data model (Prisma — additive)

`apps/dashboard/prisma/schema.prisma`. Four new models + one back-relation on `Machine`.

```prisma
model KnowledgeBase {
  id             String   @id @default(cuid())
  machineId      String
  machine        Machine  @relation(fields: [machineId], references: [id], onDelete: Cascade)
  slug           String                          // dir name → .claude/skills/kb-<slug>/
  name           String
  intro            String   @default("") @db.Text // always-loaded summary → SKILL.md description
  autoIntro        Boolean  @default(true)         // Brain's dream may rewrite intro when true
  introUpdatedAt   DateTime @default(now())        // bumped when intro changes
  contentUpdatedAt DateTime @default(now())        // bumped on any doc create/update/delete/reorder
  createdAt        DateTime @default(now())
  updatedAt      DateTime @updatedAt
  docs           KnowledgeDoc[]
  attachments    AgentKnowledgeBase[]
  @@unique([machineId, slug])
}

model KnowledgeDoc {
  id              String   @id @default(cuid())
  knowledgeBaseId String
  knowledgeBase   KnowledgeBase @relation(fields: [knowledgeBaseId], references: [id], onDelete: Cascade)
  title           String
  filename        String                          // <filename>.md within kb-<slug>/docs/, unique per KB
  content         String   @default("") @db.Text  // markdown
  sortOrder       Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@unique([knowledgeBaseId, filename])
}

model AgentKnowledgeBase {                          // attachment: which agent has which KB
  machineId       String
  agentName       String
  knowledgeBaseId String
  knowledgeBase   KnowledgeBase @relation(fields: [knowledgeBaseId], references: [id], onDelete: Cascade)
  createdAt       DateTime @default(now())
  @@id([machineId, agentName, knowledgeBaseId])
  @@index([machineId, agentName])
}

model KnowledgeBaseRequest {                        // DB→disk materialization queue (mirrors GlobalSkillRequest)
  id        String   @id @default(cuid())
  machineId String
  agentName String                                 // whose .claude/skills/ to write
  slug      String                                 // kb-<slug>
  kind      String                                 // "materialize" | "remove"
  payload   Json?                                  // { name, intro, docs: [{ filename, title, content }] }
  status    String   @default("pending")           // pending | done | error
  createdAt DateTime @default(now())
  @@index([machineId, status])
}
```

Add to `Machine`: `knowledgeBases KnowledgeBase[]`.

Existing pattern anchors: `GlobalSkill` (schema.prisma:169–188), `GlobalSkillRequest` (193–207), `AgentSkillInstall` (586–596), `GlobalMemory` (209–219). Migration is hand-written & additive, applied by the VPS deploy (`prisma migrate deploy`).

**Slug/filename rules:**
- `slug` = kebab-slugify(`name`), lowercased, `[a-z0-9-]`; on `[machineId, slug]` collision append `-2`, `-3`, …
- `filename` = kebab-slugify(`title`) + `.md`; on `[knowledgeBaseId, filename]` collision append `-2`, …. Assigned once at doc creation and kept **stable** across `title` edits (rename is a separate explicit action), so a title tweak doesn't churn the disk file.
- `introUpdatedAt` is bumped whenever `intro` changes (user edit *or* Brain write). `contentUpdatedAt` is bumped on any doc create/update/delete/reorder. "Docs changed since the intro was written" = `contentUpdatedAt > introUpdatedAt` — a stored counter, robust to deletions (a computed `max(doc.updatedAt)` would regress when the newest doc is deleted).

---

## 3. On-disk materialization (Approach A)

When a KB is attached to an agent, the gateway writes:

```
<agent_dir>/.claude/skills/kb-<slug>/
├── SKILL.md
└── docs/
    ├── <filename>.md      ← one file per KnowledgeDoc
    └── …
```

`SKILL.md` is generated deterministically from the KB snapshot:

```markdown
---
name: <name>
description: <intro>            # falls back to "Knowledge base: <name>" when intro is empty
hermit_kind: knowledge         # marker so skill collectors skip this dir
---
# <name>

Consult this knowledge base when relevant. Read the specific document below rather
than answering from memory.

Documents:
- `docs/<filename>.md` — <title>
- …
```

- The `description` frontmatter is the always-resident intro (Claude Code preloads only this).
- The body (document index) loads when the skill is triggered.
- `docs/*.md` load only when the agent `Read`s them → three-level progressive load.
- `hermit_kind: knowledge` is the exclusion signal (§6).

Discovery paths Claude Code already scans: `~/.claude/skills/` (machine) and `<agent_dir>/.claude/skills/` (agent). We use the **agent** dir only (per-agent attach). Machine-wide attach (`~/.claude/skills/kb-*`) is out of scope v1.

---

## 4. Gateway sync

New module `apps/gateway/src/knowledge.ts`, mirroring `global-skills.ts`:

- `applyKnowledgeRequest(req)` —
  - `materialize`: from `req.payload`, generate `SKILL.md` + write each `docs/<filename>.md`. Reuse the safe multi-file write from skills (`..`-traversal guard + recursive `mkdir`; see `global-skills.ts:writeSkillRefs` 223–239 / `agent-lifecycle.ts:writeSkillRefs` 245–261). Overwrite the dir's managed files; prune doc files no longer present.
  - `remove`: `rm -rf <agent_dir>/.claude/skills/kb-<slug>/`.
- `knowledgeRequestTick()` — every ~3 s (wire in `apps/gateway/src/index.ts` next to `globalSkillRequestTick`, index.ts:93–95): poll `knowledge.pollRequests`, apply each, `knowledge.ackRequest` (done/error).
- `reconcileKnowledgeOnStartup()` — runs **once** at gateway start (not per-tick — respects the "no per-tick full scans" rule): for each agent, materialize its attached KBs and delete stale `kb-*` dirs the DB no longer lists. Catches requests missed while the gateway was down.

**Change propagation (event-driven fan-out, done in the tRPC mutations, not by polling):**
- Attach → enqueue one `materialize` for that agent.
- Detach → enqueue one `remove` for that agent.
- Edit intro / doc create/update/delete/reorder / KB rename → enqueue a `materialize` for **every** agent in `AgentKnowledgeBase` for that KB (small, event-driven).
- Delete KB → cascade docs + enqueue `remove` for every attached agent.

Gateway changes require a **per-machine restart** to take effect; roll out to all three machines (Mac + 2 macminis) at the end.

---

## 5. tRPC router `knowledge`

New `apps/dashboard/src/server/routers/knowledge.ts`, mounted in `_app.ts` (alongside `globalMemory`, line 29). Library + attach procedures are `machineProcedure` (v1; scoped share-links can't manage KBs — same posture as `market.installToAgent`). Gateway procedures are `machineProcedure` too (gateway holds a machine key).

| Procedure | Kind | Purpose |
|---|---|---|
| `listBases` | query | `[{ id, slug, name, intro, autoIntro, introUpdatedAt, contentUpdatedAt, docCount, attachedAgentCount }]` |
| `getBase` | query | one KB + its docs **metadata** (`{ id, title, filename, sortOrder, updatedAt }[]`), no content |
| `docContent` | query | one doc's markdown (heavy — split out, like `skills.content` 46–53) |
| `baseDocs` | query | all docs of a KB **with content** (single call for the Brain's `kb_read_docs`) |
| `createBase` | mutation | `{ name, intro? }` → new KB (+slug) |
| `updateBase` | mutation | `{ id, name?, intro?, autoIntro? }` → see intro/autoIntro rule below; fan-out materialize |
| `deleteBase` | mutation | cascade docs + fan-out remove |
| `createDoc` | mutation | `{ baseId, title, content? }` → fan-out materialize |
| `updateDoc` | mutation | `{ id, title?, content? }` → fan-out materialize |
| `deleteDoc` | mutation | `{ id }` → fan-out materialize |
| `reorderDocs` | mutation | `{ baseId, orderedIds[] }` → fan-out materialize |
| `setIntro` | mutation | `{ id, intro }` — **Brain-facing**; updates intro + `introUpdatedAt`, **keeps** `autoIntro`; fan-out materialize |
| `attachToAgent` | mutation | `{ agentName, baseId }` → row + enqueue materialize for that agent |
| `detachFromAgent` | mutation | `{ agentName, baseId }` → drop row + enqueue remove for that agent |
| `listAgentBases` | query | `{ agentName }` → KBs attached to an agent (agent-detail section) |
| `pollRequests` | query | gateway: pending `KnowledgeBaseRequest` rows |
| `ackRequest` | mutation | gateway: mark request done/error |

**intro / autoIntro rule in `updateBase`** (distinguishes a human edit from the Brain):
- If `input.autoIntro` is provided → set it (lets the UI toggle Auto ⇄ Manual explicitly).
- Else if `input.intro` is provided and differs from the stored value → this is a **manual** edit: set the new intro **and** `autoIntro = false` (the user has taken over; the Brain stops touching it).
- Setting `intro` always bumps `introUpdatedAt`.
- The Brain never calls `updateBase`; it calls `setIntro`, which preserves `autoIntro`.
- `createDoc` / `updateDoc` / `deleteDoc` / `reorderDocs` each bump the KB's `contentUpdatedAt` (drives the dream's "changed since intro" check) and fan out a re-materialize.

---

## 6. Skill-collector exclusion (`hermit_kind: knowledge`)

Because KBs live under `.claude/skills/`, the existing collectors would otherwise ingest them as skills. Filter them out by the frontmatter marker at collection time (UI reads from the collected set, so this is sufficient):

- `apps/gateway/src/global-skills.ts` — `collectGlobalSkills` (190–201): skip dirs whose SKILL.md frontmatter has `hermit_kind: knowledge`. Extend `parseFrontmatter` (47–70) to surface that field.
- `apps/gateway/src/collect/agents.ts` — `listSkills` (41–53) / `listSkillDocs` (84–94): same skip.

The marker (not the `kb-` name prefix) is the authority — a human skill happening to be named `kb-*` without the marker stays a real skill.

---

## 7. UI

**Sidebar** (`apps/dashboard/src/components/app-sidebar.tsx`, `NAV` 68–74): add `{ href: '/knowledge', label: 'Knowledge', icon: BookOpen }` after Cron (the old Settings slot). Route-active via `pathname.startsWith('/knowledge')`. Add a CTA branch (407–415): on `/knowledge` → "New knowledge base" (`/knowledge?new=1`). v1 keeps `/knowledge` a plain dashboard-nav item — **no** dedicated sidebar "mode" (could be added later like Market/Brain).

**`/knowledge` (`app/knowledge/page.tsx`)** — the library: a list/grid of KB cards (`name`, `intro`, doc count, attached-agent count) + "New knowledge base".

**`/knowledge/[slug]` (`app/knowledge/[slug]/page.tsx`)** — the KB editor:
- Edit `name` and `intro`. The intro field shows an **Auto / Manual** indicator: when `autoIntro` is true, a hint "Auto — refreshed by the Brain's dream; editing switches to Manual"; saving an edited intro flips it to Manual (`updateBase` rule); a one-click control re-enables Auto (`updateBase { autoIntro: true }`).
- Documents master-detail: doc list (add / rename / delete / reorder) on the left, a markdown editor on the right. Reuse the existing markdown/file editor components (e.g. the `global-memory-files.tsx` editor pattern / `file-detail.tsx`).

**Agent detail** (`apps/dashboard/src/components/agent-detail-sheet.tsx`): add a `KnowledgeBases` section inside `AgentDetailContent`'s **detail** tab (150–182), directly after `SkillsAndTasks`. It lists the agent's attached KBs (`name` + `intro` + doc count) with a detach control, and an "Attach knowledge base" button opening a picker of the machine's KBs (a new `AttachKnowledgeDialog`, mirroring `InstallSkillDialog`). Calls `knowledge.listAgentBases` / `attachToAgent` / `detachFromAgent`. No new tab — a section, matching the "list, like skills" ask.

All user-visible strings in **English** (dashboard UI convention).

---

## 8. Brain dream — automatic intro refresh

The Brain's dream is a daily `Cron` (`title: 'Daily dream'`, `intervalSec 86400`, `jitterSec 3600`) whose prompt tells the Brain to follow its `dreaming` skill (`brain-template.ts`: `BRAIN_DREAM_PROMPT` 116–117, `BRAIN_DREAMING_SKILL` 62–114, deployed to `.claude/skills/dreaming/SKILL.md`). The Brain runs with `HERMIT_BRAIN=1` and can use the brain-only MCP tools in `apps/gateway/src/mcp-stub.cjs` (`BRAIN_TOOLS` 286–359 + `dispatchBrainTool` 362–509), which call machine-scoped tRPC.

**Three new brain MCP tools** (add to `BRAIN_TOOLS` + `dispatchBrainTool`, gated by `HERMIT_BRAIN`):

| Tool | Wraps | Returns / effect |
|---|---|---|
| `kb_list()` | `knowledge.listBases` | KBs with `intro`, `autoIntro`, `docCount`, `contentUpdatedAt`, `introUpdatedAt` |
| `kb_read_docs({ baseId })` | `knowledge.baseDocs` | that KB's docs with content |
| `kb_set_intro({ baseId, intro })` | `knowledge.setIntro` | writes intro (preserves `autoIntro`), fans out re-materialize |

The Brain is machine-scoped, so it sees every KB on the machine — it does **not** need to attach them.

**Dreaming-skill step** (add to `BRAIN_DREAMING_SKILL`, bump `BRAIN_TEMPLATE_VERSION` 2 → 3 so existing brains re-overlay the skill; only that file is re-overlaid, memory is untouched):

> **Refresh knowledge-base intros.** Call `kb_list()`. For each KB with `autoIntro` true **and** `contentUpdatedAt` newer than `introUpdatedAt`, call `kb_read_docs(id)`, write a concise 1–3-sentence intro (what it contains + when an agent should consult it), and save with `kb_set_intro(id, intro)`. Skip KBs with no docs.

No change to `BRAIN_DREAM_PROMPT` (it already delegates to the skill).

**Overwrite policy:** `KnowledgeBase.autoIntro` (default `true`). The dream only rewrites intros where it's true. A manual intro edit in the UI flips it to false (§5); the UI can flip it back. Machines with no Brain simply never auto-refresh — hand-written intros persist.

---

## 9. Scoping, error handling, edge cases

- **Scope:** all library/attach/gateway procedures are `machineProcedure` (rejects `scope === 'agent'` share keys — see `trpc.ts:43–47`). The gateway's `HERMIT_KEY` is a machine key.
- **Delete an attached KB:** cascade its docs, drop `AgentKnowledgeBase` rows, and enqueue `remove` for each attached agent so disk is cleaned.
- **Empty KB / empty intro:** SKILL.md `description` falls back to `Knowledge base: <name>`; a KB with no docs still materializes (index empty) and the dream skips its intro.
- **Large docs:** metadata vs content are split (`getBase` vs `docContent`) to keep polls small, mirroring skills.
- **Path safety:** the materializer reuses the `..`-guarded writer; `slug`/`filename` are slugified server-side so payloads can't escape the KB dir.
- **Brain absent / disabled:** `kb_*` tools only register under `HERMIT_BRAIN=1`; without a brain, intros are user-maintained only.
- **Concurrency:** DB is the single source of truth; a re-materialize is idempotent (full snapshot in `payload`), so duplicate/overlapping requests converge.

---

## 10. Verification

No unit-test harness in this repo (per the marketplace/plan convention) — verify by **hand-written additive migration + `tsc` + `next build` + runtime**:

1. Migration applies; `tsc --noEmit` and `next build` clean.
2. Create a KB + a doc in `/knowledge`; attach to a test agent → confirm `<agent_dir>/.claude/skills/kb-<slug>/SKILL.md` + `docs/*.md` on disk, with `hermit_kind: knowledge` and the intro as `description`.
3. In that agent's `claude` session, the KB shows as a skill whose description is the intro; the agent can `Read` a doc.
4. Edit the doc in the library → the agent's files re-materialize.
5. Detach → the `kb-<slug>` dir is removed.
6. The KB does **not** appear in the Global Skills settings tab nor the agent's skill list.
7. Brain dream: with a KB whose docs changed and `autoIntro` on, run "Dream now" → the intro (and the materialized `description`) update; a Manual KB is untouched.

Deploy: `git push origin main` → `ssh ubuntu@45.89.234.110 -- '~/hermit-ui/scripts/vps-deploy.sh'` (runs `prisma migrate deploy` + `next build` + restart). Gateway changes need a per-machine restart; roll out to all three machines.

---

## 11. File-change map

**Create**
- `apps/dashboard/src/server/routers/knowledge.ts` — the router (§5).
- `apps/dashboard/src/app/knowledge/page.tsx` — library list.
- `apps/dashboard/src/app/knowledge/[slug]/page.tsx` — KB editor (name/intro + docs master-detail).
- `apps/dashboard/src/components/attach-knowledge-dialog.tsx` — machine-KB picker for agent detail.
- `apps/gateway/src/knowledge.ts` — materializer + tick + startup reconcile (§4).
- Prisma migration under `apps/dashboard/prisma/migrations/` (hand-written, additive).

**Modify**
- `apps/dashboard/prisma/schema.prisma` — 4 models + `Machine.knowledgeBases` (§2).
- `apps/dashboard/src/server/routers/_app.ts` — mount `knowledge`.
- `apps/dashboard/src/components/app-sidebar.tsx` — `NAV` entry + CTA branch (§7).
- `apps/dashboard/src/components/agent-detail-sheet.tsx` — `KnowledgeBases` section (§7).
- `apps/gateway/src/index.ts` — wire `knowledgeRequestTick` + startup reconcile.
- `apps/gateway/src/global-skills.ts` — exclude `hermit_kind: knowledge` in `collectGlobalSkills`; extend `parseFrontmatter` (§6).
- `apps/gateway/src/collect/agents.ts` — exclude `hermit_kind: knowledge` in `listSkills` / `listSkillDocs` (§6).
- `apps/gateway/src/mcp-stub.cjs` — `kb_list` / `kb_read_docs` / `kb_set_intro` brain tools (§8).
- `apps/dashboard/src/server/brain-template.ts` — dreaming-skill KB step + `BRAIN_TEMPLATE_VERSION` bump (§8).
