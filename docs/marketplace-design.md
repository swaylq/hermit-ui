# Public Marketplace — Shared Skills + Agent Templates

_Design spec · 2026-06-05_

## Problem

Everything skill- and agent-related in hermit-ui is scoped to a single `machineId`:

- **Machine skills** (`GlobalSkill`, `~/.claude/skills/`) — created/edited/deleted from `/skills` via `GlobalSkillRequest`. `source` is `manual | git | plugin`; there is **no import-from-URL** and no way to share a skill with another machine.
- **Agent skills** (`Agent.skills`, `<agent_dir>/.claude/skills/`) — viewed/edited from the agent-detail sheet via `AgentRequest(edit)`. No publish, install, or update.
- **Agent template** — a single built-in tree at `apps/cli/template/`. Create-agent only takes `name` + `persona`; the gateway always scaffolds from that one template. No way to capture an existing agent as a reusable template.

There is no shared place to publish, discover, version, install, or update skills and templates across the fleet (now multi-machine: the macmini is a second node).

## Goal

A **fleet-wide marketplace** — a registry shared by every machine/agent that connects to this dashboard — for skills and agent templates, with light versioning. Five capabilities (sway's spec):

1. A left-top sidebar button switches the sidebar into **Market mode**; switch back to Dashboard mode.
2. Per agent: publish one of its skills to the market; install a market skill into the agent; pull updates; uninstall.
3. `/skills` (machine level): install a market skill onto the machine; pull updates; uninstall.
4. Quick-import a skill from a GitHub link or an install-URL (e.g. `master-skill.org/install/speech-to-text`).
5. Condense an agent into a template (strip private traits — accounts, project memory) and publish it; create a new agent from a market template.

## Approach: a dashboard-global registry; the gateway stays dumb

The marketplace lives in the **dashboard DB** (VPS Postgres) as new models that are **not** `machineId`-scoped — they are visible to every machine. External URLs (GitHub, master-skill.org) are **import sources** that populate the registry; they are not the marketplace itself.

Install/update/uninstall reuse the proven **Request + poll + ack** pattern the gateway already runs (`GlobalSkillRequest`, `AgentRequest`). The dashboard resolves a market version into a concrete **file set** and hands it to the gateway through a Request row; the gateway only writes files under `.claude/skills/` and acks. The gateway never gains DB access and never fetches the internet (it is Mac-LAN-bound) — **the dashboard does all external fetching** (it has public egress).

Rejected alternative — a truly central, internet-wide service (master-skill.org as our shared backend others publish to) — is far larger and unnecessary: sway's point 4 frames master-skill.org as a source to import *from*. We treat it as one import adapter.

## Scope & phasing

Four subsystems, each its own plan + implementation, built in order. This doc details **Phase A** to implementation granularity and designs B/C/D.

- **A — Foundation:** registry models, the sidebar mode-switch + Market pages (browse skills/templates, version history), and a minimal **publish** path so the market is non-empty and testable end-to-end.
- **B — Skill lifecycle:** install / update / uninstall at machine and agent level, provenance-driven "update available".
- **C — External import:** adapter framework (master-skill.org, GitHub, raw SKILL.md) with preview-before-commit.
- **D — Agent templates:** condense → strip → publish, and create-agent-from-template.

## Data model

New dashboard-global tables (`apps/dashboard/prisma/schema.prisma`). No `machineId` on the registry itself.

```prisma
model MarketSkill {
  id                   String   @id @default(cuid())
  slug                 String   @unique   // install handle == .claude/skills/<slug> dir name
  displayName          String
  description          String?  @db.Text
  origin               String   @default("uploaded") // uploaded | github | master-skill.org | manual
  originUrl            String?            // canonical source URL, for re-pull
  category             String?            // industry / grouping for browse
  tags                 String[] @default([])
  latestVersion        String             // newest MarketSkillVersion.version
  publishedByMachineId String?            // provenance (nullable)
  publishedByAgent     String?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  versions             MarketSkillVersion[]
}

model MarketSkillVersion {
  id            String   @id @default(cuid())
  marketSkillId String
  marketSkill   MarketSkill @relation(fields: [marketSkillId], references: [id], onDelete: Cascade)
  version       String              // semver-ish or auto-incrementing "1", "2", …
  changelog     String?  @db.Text
  content       String?  @db.Text   // SKILL.md (null for bundle-only)
  refs          Json     @default("[]") // Array<{ path, content }> — references/, cli/, sub-skills/
  fileCount     Int      @default(0)
  contentHash   String              // dedup identical re-publishes + drive update detection
  createdAt     DateTime @default(now())
  createdByMachineId String?
  @@unique([marketSkillId, version])
}

model MarketTemplate {
  id                   String   @id @default(cuid())
  slug                 String   @unique
  displayName          String
  description          String?  @db.Text
  basePersona          String?  @db.Text // genericized persona seed
  origin               String   @default("uploaded") // uploaded(from-agent) | manual
  publishedByMachineId String?
  sourceAgent          String?            // which agent it was condensed from
  latestVersion        String
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  versions             MarketTemplateVersion[]
}

model MarketTemplateVersion {
  id               String   @id @default(cuid())
  marketTemplateId String
  marketTemplate   MarketTemplate @relation(fields: [marketTemplateId], references: [id], onDelete: Cascade)
  version          String
  changelog        String?  @db.Text
  files            Json     @default("[]") // Array<{ path, content }> — the stripped template tree
  includedSkills   String[] @default([])   // market skill slugs this template installs
  createdAt        DateTime @default(now())
  @@unique([marketTemplateId, version])
}
```

**Provenance on installed copies** (so "pull updates" can compare versions):

- `GlobalSkill` — add `marketSkillId String?` + `marketVersion String?`. A machine skill installed from the market carries its origin + installed version.
- New `AgentSkillInstall` — agent-level provenance (the gateway pushes `Agent.skills` from disk and can't know origin, so the install flow records it dashboard-side):

```prisma
model AgentSkillInstall {
  id            String   @id @default(cuid())
  machineId     String
  agentName     String
  skillName     String
  marketSkillId String
  marketVersion String
  installedAt   DateTime @default(now())
  @@unique([machineId, agentName, skillName])
}
```

"Update available" = `installedVersion != MarketSkill.latestVersion` (compared in a tRPC query that joins provenance against `MarketSkill`).

## Navigation & UI

A **sidebar mode-switch**, not in-page tabs. A left-top button flips the whole sidebar between Dashboard mode and Market mode. The sidebar component (`components/app-sidebar.tsx`) chooses which nav to render from the pathname (`/market/*` → Market sidebar).

```
DASHBOARD MODE                       MARKET MODE  (routes: /market/skills, /market/templates)
┌ sidebar ─────────┐                 ┌ sidebar ─────────┐
│ [workspace ▾]    │                 │ ← Dashboard      │  back to dashboard sidebar
│ ┌──────────────┐ │                 │ ──────────────── │
│ │ 🏪 Market  → │ │ ──click──▶       │ 🧩 Skills        │  market nav (toggle list)
│ └──────────────┘ │                 │ 📦 Templates     │
│ ──────────────── │                 │                  │
│  Chat            │   ◀── ←Dashboard │  right pane =    │
│  Agents          │                 │  the selected    │
│  Cron            │                 │  list            │
│  Skills          │                 │                  │
│  Usage           │                 │                  │
│  …agent list…    │                 │                  │
└──────────────────┘                 └──────────────────┘
```

**Skills list** (right pane of `/market/skills`): card grid — slug, displayName, latest version, source badge (`🐙 github` / `master.skill` / `⬆ uploaded` / `manual`), search box, category filter, and (Phase C) an `➕ Import` button. Each card → a **skill detail** view: version history + changelog + SKILL.md preview + refs + source, plus the install actions (Phase B: `Install ▾` = to this machine / to an agent).

**Templates list** (`/market/templates`): cards — template, version, source, `Create agent from this` (Phase D).

The Market button sits **above** the five dashboard nav items, near the workspace switcher, visually separated from regular navigation.

## master-skill.org integration (informs Phase C)

master-skill.org ("Master.skill") is a live directory of ~50 industry-master skills in **Claude-Code format** (`SKILL.md` + `cli/*.sh` + `sub-skills/<persona>/SKILL.md`). It exposes a clean API:

- `GET https://master-skill.org/api/skills/<slug>` → JSON manifest: `slug`, `current.skill_md` (SKILL.md text), `current.cli_scripts` (executable tools), `sub_skills[]`, `sources[]`.
- `GET …?format=markdown` → raw SKILL.md (`text/markdown`).
- Human URLs: `/skill/<slug>`, `/install/<slug>`.

Note: master.skill skills are thin clients that call master.skill's hosted backend (token-billed on their side). This doesn't change the import mechanism — we fetch SKILL.md + scripts the same way as any other source. (Their billing is out of our scope.)

## Phase A — Foundation (implement first)

**Files & work:**

1. **Schema + migration** (`prisma/schema.prisma`, hand-written migration): the four registry tables + `AgentSkillInstall` + the two `GlobalSkill` columns. Additive — safe `migrate deploy` on the VPS.
2. **Market router** (`server/routers/market.ts`, mounted in the tRPC root): `listSkills` (search/category), `getSkill` (+versions), `listTemplates`, `getTemplate`, and the seed **`publishSkillFromLocal`** (takes a `GlobalSkill` name or an `(agentName, skillName)` and creates `MarketSkill` + first `MarketSkillVersion` from data already in the DB). `publishSkillFromLocal` is the minimal write path that makes the market non-empty and testable without the gateway or external fetch.
3. **Sidebar mode-switch** (`components/app-sidebar.tsx`): render Dashboard vs Market nav by pathname; the `🏪 Market` button and the `← Dashboard` back button.
4. **Market pages** (`app/market/skills/page.tsx`, `app/market/templates/page.tsx`, shared layout): the list views + skill-detail (browse + version history, read-only in A). Reuse `FileList`/`DetailModal` from `components/file-detail.tsx` for SKILL.md/ref previews.

**A is done when:** you can publish an existing skill into the market, switch the sidebar to Market mode, browse it, open it, and see its version + SKILL.md. No install yet (that is B).

## Phase B — Skill lifecycle

Wire market ↔ machine ↔ agent. The dashboard resolves a `MarketSkillVersion` into `{ content, refs }` and issues a Request:

- **Machine install:** extend `GlobalSkillRequest` with a `refs Json?` field and an `install` path; the gateway's skill-writer learns to write **multiple files** (SKILL.md + `cli/*` + `sub-skills/*`) into `~/.claude/skills/<slug>/`, not just a single SKILL.md. On ack, set `GlobalSkill.marketSkillId/marketVersion`.
- **Agent install:** add an `AgentRequest` kind `install-skill` carrying `{ skillName, content, refs }`; the gateway writes `<agent_dir>/.claude/skills/<skillName>/…`. On ack, upsert `AgentSkillInstall`.
- **Update:** re-issue install with the latest version's files; bump the provenance version.
- **Uninstall:** a delete Request (rm the skill dir) + drop the provenance row.
- **Publish (agent skill → market):** the `publishSkillFromLocal` mutation lands in A (seed path); B adds the publish controls to the agent-detail skills section and `/skills`. Note: `Agent.skills` currently carries only `{ name, content }` (SKILL.md), so multi-file (`cli/`, `sub-skills/`) publish needs the gateway push to also include per-skill `refs`; until then publish captures SKILL.md only.
- **UI:** install/update/uninstall controls on `/skills` cards and in the agent-detail skills section; an "update available" pill driven by the provenance query.

## Phase C — External import

Dashboard-server-side fetch with a small **adapter** interface:

```ts
type ImportResult = {
  slug: string; displayName: string; description?: string;
  content: string | null; refs: { path: string; content: string }[];
  origin: 'github' | 'master-skill.org' | 'manual'; originUrl: string;
};
resolve(url: string): Promise<ImportResult>
```

- **master-skill.org adapter:** parse slug from `/install/<slug>` or `/skill/<slug>` → `GET /api/skills/<slug>` → map `current.skill_md`→content, `current.cli_scripts` + `sub_skills`→refs, `sources`→description.
- **GitHub adapter:** a repo/dir/SKILL.md URL → fetch raw SKILL.md + sibling `references/`/`cli/` files (GitHub contents API or raw.githubusercontent).
- **Raw adapter:** any URL returning `text/markdown` → SKILL.md only.

Flow: paste URL → server `resolve` → **preview** (SKILL.md + file tree + source/trust) → operator confirms → create `MarketSkill`+version. Preview-before-commit is the security gate.

## Phase D — Agent templates

**Condense → strip → publish.** Source is the agent's DB data (`identityText`, `agentsText`, `toolsText`, `userText`, `skills`, `evolutionFiles`, `memoryFiles`).

- **Strip (private):** `userText` (USER.md), account/secret lines in `toolsText` (TOOLS.md → genericized stub), `memoryFiles` (Claude Code auto-memory), evolution `accounts.md` / `heartbeat.md` / `reflections/*`, any `.env`, absolute host paths.
- **Keep + genericize:** `identityText` (persona; replace the specific agent name with the `{{AGENT_NAME}}` placeholder the base template already uses), `agentsText` (workspace rules), the **skill set** (reference market slugs where skills are market-sourced, else inline). `README`/`CLAUDE`/`start.sh`/`restart.sh`/`scripts` come from the base template, not the agent.
- The strip is best-effort and **must be reviewed**: show a kept/stripped preview before publish (private data can hide in AGENTS.md/IDENTITY.md). Human-in-the-loop is the safety boundary.

**Create-from-template:** the create-agent dialog gains a template picker (built-in default | market templates). `AgentRequest(create)` carries `templateId` + `version`; the gateway scaffolds from the template's `files` (substituting `{{AGENT_NAME}}` etc.) instead of the built-in tree, then installs `includedSkills`.

## Security considerations

Installed/imported skills are auto-surfaced into the agent's system prompt and invocable via the Skill tool — a supply-chain / code-execution surface. Mitigations baked into the design:

1. **Preview before install/import** — SKILL.md + full file tree shown; human confirms. No silent fetch-and-run.
2. **Provenance + trust badges** — `uploaded` (you) vs `github`/`master-skill.org` (external).
3. **No auto-update** — updates are manual, so installed content can't silently change under a running agent.
4. **Allow-listed write path** — installs flow through the existing Request mechanism; the gateway writes only under `.claude/skills/`, never arbitrary paths (same containment guard as `AgentRequest(edit)`).
5. **Template publish review** — the strip is best-effort; the operator reviews the condensed template (kept/stripped diff) before it leaves the machine.

## Versioning (v1)

Version history + update-detection + install-a-specific-version. **No** diff UI, **no** auto-update, **no** dedicated rollback UI (rollback = install an older version). `contentHash` dedups identical re-publishes (re-publishing unchanged content is a no-op, not a new version).

## Open / deferred

- An install always targets a concrete machine (`~/.claude/skills/`) or an agent on a machine; **browse** is fleet-shared. Cross-machine "install everywhere" is deferred.
- Skill ratings / popularity / dependencies between skills — deferred; YAGNI for a single-operator fleet.
