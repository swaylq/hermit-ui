# Marketplace Phase A (Foundation) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax. Spec: `docs/marketplace-design.md`.

**Goal:** Stand up the fleet-wide marketplace foundation — registry models, a Market tRPC router, the sidebar Dashboard⇄Market mode-switch, and Market browse pages — with a minimal "publish a local skill" seed path so it is testable end-to-end.

**Architecture:** New dashboard-global Prisma models (no `machineId` on the registry). A `market` tRPC router (auth via `machineProcedure`, queries the global `Market*` tables; publish reads the machine-scoped source). `AppSidebar` branches on `pathname.startsWith('/market')` to render Market nav. Pages live under `app/market/`; the existing `auth-gate.tsx` shell wraps them with the sidebar. **Phase A is 100% dashboard-side — no gateway changes.**

**Tech Stack:** Next.js (custom server), tRPC + superjson, Prisma + Postgres (VPS), Tailwind. No unit-test harness — verification is `prisma validate` / `prisma generate` / `tsc` / `next build` / runtime.

**Deploy:** `git push origin main` → VPS `~/hermit-ui/scripts/vps-deploy.sh` (runs `prisma migrate deploy` + `prisma generate` + `next build` + restart `hermit-ui-dashboard`). No `pm2` gateway restart.

---

## File structure

- `apps/dashboard/prisma/schema.prisma` — add 5 models + 2 `GlobalSkill` columns.
- `apps/dashboard/prisma/migrations/20260605HHMMSS_add_marketplace/migration.sql` — hand-written additive migration.
- `apps/dashboard/src/server/routers/market.ts` — **new**, the market router.
- `apps/dashboard/src/server/routers/_app.ts` — mount `market`.
- `apps/dashboard/src/components/app-sidebar.tsx` — Dashboard⇄Market mode-switch.
- `apps/dashboard/src/app/market/page.tsx` — redirect to `/market/skills`.
- `apps/dashboard/src/app/market/skills/page.tsx` — skills list + detail modal + seed publish.
- `apps/dashboard/src/app/market/templates/page.tsx` — templates list (empty-state in A).
- `apps/dashboard/src/components/market-skill-detail.tsx` — version-history + SKILL.md preview modal (reuses `file-detail.tsx`).

---

## Task 1: Schema + migration

**Files:**
- Modify: `apps/dashboard/prisma/schema.prisma`
- Create: `apps/dashboard/prisma/migrations/20260605HHMMSS_add_marketplace/migration.sql`

- [ ] **Step 1: Add models + columns to `schema.prisma`** (append after the `GlobalSkill` model; add the two columns inside `GlobalSkill`).

Add to the `GlobalSkill` model (after `fileCount`):
```prisma
  marketSkillId String? // set when installed from the marketplace
  marketVersion String?
```

Append:
```prisma
model MarketSkill {
  id                   String   @id @default(cuid())
  slug                 String   @unique
  displayName          String
  description          String?  @db.Text
  origin               String   @default("uploaded") // uploaded | github | master-skill.org | manual
  originUrl            String?
  category             String?
  tags                 String[] @default([])
  latestVersion        String
  publishedByMachineId String?
  publishedByAgent     String?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  versions             MarketSkillVersion[]
}

model MarketSkillVersion {
  id                 String   @id @default(cuid())
  marketSkillId      String
  marketSkill        MarketSkill @relation(fields: [marketSkillId], references: [id], onDelete: Cascade)
  version            String
  changelog          String?  @db.Text
  content            String?  @db.Text
  refs               Json     @default("[]")
  fileCount          Int      @default(0)
  contentHash        String
  createdAt          DateTime @default(now())
  createdByMachineId String?
  @@unique([marketSkillId, version])
}

model MarketTemplate {
  id                   String   @id @default(cuid())
  slug                 String   @unique
  displayName          String
  description          String?  @db.Text
  basePersona          String?  @db.Text
  origin               String   @default("uploaded")
  publishedByMachineId String?
  sourceAgent          String?
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
  files            Json     @default("[]")
  includedSkills   String[] @default([])
  createdAt        DateTime @default(now())
  @@unique([marketTemplateId, version])
}

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

- [ ] **Step 2: Write the migration SQL** at `prisma/migrations/20260605HHMMSS_add_marketplace/migration.sql` (use a real timestamp ≥ the latest `20260604081009`):

```sql
ALTER TABLE "GlobalSkill" ADD COLUMN "marketSkillId" TEXT;
ALTER TABLE "GlobalSkill" ADD COLUMN "marketVersion" TEXT;

CREATE TABLE "MarketSkill" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "description" TEXT,
  "origin" TEXT NOT NULL DEFAULT 'uploaded',
  "originUrl" TEXT,
  "category" TEXT,
  "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "latestVersion" TEXT NOT NULL,
  "publishedByMachineId" TEXT,
  "publishedByAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketSkill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketSkill_slug_key" ON "MarketSkill"("slug");

CREATE TABLE "MarketSkillVersion" (
  "id" TEXT NOT NULL,
  "marketSkillId" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "changelog" TEXT,
  "content" TEXT,
  "refs" JSONB NOT NULL DEFAULT '[]',
  "fileCount" INTEGER NOT NULL DEFAULT 0,
  "contentHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByMachineId" TEXT,
  CONSTRAINT "MarketSkillVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketSkillVersion_marketSkillId_version_key" ON "MarketSkillVersion"("marketSkillId", "version");
ALTER TABLE "MarketSkillVersion" ADD CONSTRAINT "MarketSkillVersion_marketSkillId_fkey" FOREIGN KEY ("marketSkillId") REFERENCES "MarketSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MarketTemplate" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "description" TEXT,
  "basePersona" TEXT,
  "origin" TEXT NOT NULL DEFAULT 'uploaded',
  "publishedByMachineId" TEXT,
  "sourceAgent" TEXT,
  "latestVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketTemplate_slug_key" ON "MarketTemplate"("slug");

CREATE TABLE "MarketTemplateVersion" (
  "id" TEXT NOT NULL,
  "marketTemplateId" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "changelog" TEXT,
  "files" JSONB NOT NULL DEFAULT '[]',
  "includedSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketTemplateVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketTemplateVersion_marketTemplateId_version_key" ON "MarketTemplateVersion"("marketTemplateId", "version");
ALTER TABLE "MarketTemplateVersion" ADD CONSTRAINT "MarketTemplateVersion_marketTemplateId_fkey" FOREIGN KEY ("marketTemplateId") REFERENCES "MarketTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentSkillInstall" (
  "id" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "agentName" TEXT NOT NULL,
  "skillName" TEXT NOT NULL,
  "marketSkillId" TEXT NOT NULL,
  "marketVersion" TEXT NOT NULL,
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentSkillInstall_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentSkillInstall_machineId_agentName_skillName_key" ON "AgentSkillInstall"("machineId", "agentName", "skillName");
```

- [ ] **Step 3: Validate + regenerate the client locally.** Run: `cd apps/dashboard && npx prisma validate && npx prisma generate`. Expected: "The schema is valid" + client regenerated. (The actual `migrate deploy` runs on the VPS at deploy time.)
- [ ] **Step 4: Commit.** `git add apps/dashboard/prisma/schema.prisma apps/dashboard/prisma/migrations/20260605* && git commit -m "feat(market): registry schema + migration (skills, templates, installs)"`

---

## Task 2: Market tRPC router

**Files:**
- Create: `apps/dashboard/src/server/routers/market.ts`
- Modify: `apps/dashboard/src/server/routers/_app.ts`

- [ ] **Step 1: Write `market.ts`** — auth via `machineProcedure`; the registry queries are global (no `machineId` filter); `publishSkillFromLocal` reads the machine-scoped source and dedups by `contentHash`:

```ts
import { z } from 'zod';
import crypto from 'node:crypto';
import { router, machineProcedure } from '../trpc';
import { prisma } from '../db';

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
      if (input?.q) where.OR = [
        { slug: { contains: input.q, mode: 'insensitive' } },
        { displayName: { contains: input.q, mode: 'insensitive' } },
        { description: { contains: input.q, mode: 'insensitive' } },
      ];
      if (input?.category) where.category = input.category;
      return prisma.marketSkill.findMany({
        where, orderBy: { updatedAt: 'desc' },
        select: { id: true, slug: true, displayName: true, description: true, origin: true, category: true, tags: true, latestVersion: true, updatedAt: true },
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
      select: { id: true, slug: true, displayName: true, description: true, origin: true, sourceAgent: true, latestVersion: true, updatedAt: true },
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
      where: { machineId: ctx.machine.id }, orderBy: { name: 'asc' },
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
        where: { slug }, include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (existing) {
        if (existing.versions[0]?.contentHash === hash) return existing; // identical re-publish = no-op
        const nextVer = String((parseInt(existing.latestVersion, 10) || 0) + 1);
        await prisma.marketSkillVersion.create({
          data: { marketSkillId: existing.id, version: nextVer, content, refs, fileCount, contentHash: hash, changelog: input.changelog ?? null, createdByMachineId: ctx.machine.id },
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
          versions: { create: { version: '1', content, refs, fileCount, contentHash: hash, changelog: input.changelog ?? null, createdByMachineId: ctx.machine.id } },
        },
      });
    }),
});
```

- [ ] **Step 2: Mount in `_app.ts`** — add the import + the `market: marketRouter` line:
```ts
import { marketRouter } from './market';
// …inside router({ … }):
  market: marketRouter,
```

- [ ] **Step 3: Typecheck.** Run: `cd apps/dashboard && npx tsc --noEmit`. Expected: exit 0.
- [ ] **Step 4: Commit.** `git add apps/dashboard/src/server/routers/market.ts apps/dashboard/src/server/routers/_app.ts && git commit -m "feat(market): tRPC router (browse + publish-from-local seed)"`

---

## Task 3: Sidebar Dashboard⇄Market mode-switch

**Files:** Modify `apps/dashboard/src/components/app-sidebar.tsx`

- [ ] **Step 1: Add the market detection + market nav.** In `AppSidebar`, after `const pathname = usePathname();` add `const onMarket = pathname.startsWith('/market');`. Define a market nav array near `NAV`:
```tsx
const MARKET_NAV: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: '/market/skills', label: 'Skills', icon: Boxes },
  { href: '/market/templates', label: 'Templates', icon: Package },
];
```
(Import `Store` and `ArrowLeft` from `lucide-react` if not present; `Package` is already used elsewhere.)

- [ ] **Step 2: Render the mode-switch.** Replace the CTA block (the route-aware "New X" `Link`, lines ~239–254) + the primary-nav `<nav>` (lines ~256–279) + the recents block (lines ~281–286) with a branch:
  - **Market mode (`onMarket`):** a `← Dashboard` link (`href="/chat"`) styled like the CTA, then a `<nav>` mapping `MARKET_NAV` (same item chrome as the dashboard nav, `active = pathname.startsWith(n.href)`), then `<div className="flex-1" />` (no recents in market mode).
  - **Dashboard mode (else):** a `🏪 Market` link (`href="/market/skills"`, `Store` icon) styled like the CTA in place of the existing "New X" CTA **— keep the existing "New X" CTA too**: stack the Market button *above* it, OR (simpler, matches "最左上方") put the `Market` button as the CTA-styled row and move the "New X" CTA to the first nav row. Decision: render `Market` button as a CTA-styled row, then the existing `cta` "New X" row below it, then the existing `NAV` `<nav>`, then the existing recents. Both buttons share the CTA chrome.

Concrete render (replace the CTA+nav+recents region):
```tsx
{onMarket ? (
  <>
    <div className="px-2">
      <Link href="/chat" title="Back to dashboard"
        className={cn('flex items-center gap-2 rounded-lg h-9 text-sm font-medium transition-colors cursor-pointer border border-sidebar-border bg-sidebar hover:bg-sidebar-accent text-sidebar-foreground', collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3')}>
        <ArrowLeft className="h-4 w-4 shrink-0" />
        <span className={cn('truncate', collapsed && 'lg:hidden')}>Dashboard</span>
      </Link>
    </div>
    <nav className="px-2 pt-2 space-y-0.5">
      {MARKET_NAV.map((n) => {
        const active = pathname.startsWith(n.href);
        const Icon = n.icon;
        return (
          <Link key={n.href} href={n.href} title={n.label}
            className={cn('flex items-center gap-2.5 rounded-lg h-8 text-sm transition-colors cursor-pointer', collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3',
              active ? 'bg-sidebar-accent text-sidebar-foreground font-medium' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground')}>
            <Icon className="h-4 w-4 shrink-0" />
            <span className={cn('truncate', collapsed && 'lg:hidden')}>{n.label}</span>
          </Link>
        );
      })}
    </nav>
    <div className="flex-1" />
  </>
) : (
  <>
    {/* Market entry — CTA-styled, sits above the route-aware New-X CTA */}
    <div className="px-2">
      <Link href="/market/skills" title="Public marketplace"
        className={cn('flex items-center gap-2 rounded-lg h-9 text-sm font-medium transition-colors cursor-pointer border border-sidebar-border bg-sidebar hover:bg-sidebar-accent text-sidebar-foreground', collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3')}>
        <Store className="h-4 w-4 shrink-0" />
        <span className={cn('truncate', collapsed && 'lg:hidden')}>Market</span>
      </Link>
    </div>
    {/* …existing CTA "New X" block… */}
    {/* …existing NAV <nav>… */}
    {/* …existing recents block… */}
  </>
)}
```

- [ ] **Step 3: Typecheck + build.** Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`. Expected: build PASS. (Sanity: `/market` routes don't exist yet → the Market button 404s until Task 4; that's fine for this commit's typecheck/build.)
- [ ] **Step 4: Commit.** `git add apps/dashboard/src/components/app-sidebar.tsx && git commit -m "feat(market): sidebar Dashboard<->Market mode-switch"`

---

## Task 4: Market pages (browse) + detail modal

**Files:**
- Create: `apps/dashboard/src/app/market/page.tsx`, `app/market/skills/page.tsx`, `app/market/templates/page.tsx`
- Create: `apps/dashboard/src/components/market-skill-detail.tsx`

- [ ] **Step 1: `app/market/page.tsx`** — redirect to skills:
```tsx
import { redirect } from 'next/navigation';
export default function MarketIndex() { redirect('/market/skills'); }
```

- [ ] **Step 2: `app/market/skills/page.tsx`** — `'use client'`, `Suspense`-wrapped. Top bar: `SidebarMobileToggle` + title "Marketplace · Skills" + a search `Input` + a `Publish` button (opens the seed picker, Task 5). Body: `trpc.market.listSkills.useQuery({ q })` → card grid. Each card: `displayName`, `slug` (mono), `v{latestVersion}`, an origin badge (reuse a small inline badge: `uploaded`/`github`/`master.skill`/`manual`), `description` (clamped). Click → set `selected` slug → render `<MarketSkillDetail slug=… onClose=… />`. Empty state: "市场还没有 skill — 点 Publish 发布一个本地 skill,或等 C 阶段从 URL 导入。"

- [ ] **Step 3: `components/market-skill-detail.tsx`** — a `createPortal` modal (per `hermit-ui-base-ui-overlay-quirks`: bare portal, self-managed Esc + scroll-lock, opaque bg — mirror `file-detail.tsx`'s `DetailModal`). `trpc.market.getSkill.useQuery({ slug })`. Show: header (displayName + slug + origin), a version list (`versions[]`: `v{version}` · `relTime(createdAt)` · changelog), and the selected version's `content` via `<FileList items=[{ key:'SKILL.md', label:'SKILL.md', body: content, monoLabel:true }, ...refs]/>` from `@/components/file-detail`. Read-only (no `onSave`).

- [ ] **Step 4: `app/market/templates/page.tsx`** — same shell; `trpc.market.listTemplates.useQuery()` → card grid (`displayName`, `slug`, `v{latestVersion}`, `sourceAgent`). Empty state: "还没有 template — D 阶段从 agent 凝练发布。" (No detail modal needed in A.)

- [ ] **Step 5: Typecheck + build.** Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`. Expected: build PASS, `/market/skills` + `/market/templates` compiled.
- [ ] **Step 6: Commit.** `git add apps/dashboard/src/app/market apps/dashboard/src/components/market-skill-detail.tsx && git commit -m "feat(market): browse pages (skills list + detail modal, templates list)"`

---

## Task 5: Seed publish UI (makes A testable)

**Files:** Modify `apps/dashboard/src/app/market/skills/page.tsx`

- [ ] **Step 1: Publish dialog.** A `createPortal` modal opened by the `Publish` button. `trpc.market.localSkills.useQuery()` lists the machine's `GlobalSkill`s (`name`, `description`, `isBundle`). Pick one (exclude bundles or allow — bundles have `content:null`, so disable them with a hint "bundle 无单文件内容,A 阶段先发普通 skill"). Optional `slug` (defaults to name), `displayName`, `changelog`. `Publish` → `trpc.market.publishSkillFromLocal.mutate({ source:'global', skillName, slug?, displayName?, changelog? })`; on success `utils.market.listSkills.invalidate()` + close.

- [ ] **Step 2: Typecheck + build.** Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`. Expected: PASS.
- [ ] **Step 3: Commit.** `git add apps/dashboard/src/app/market/skills/page.tsx && git commit -m "feat(market): seed publish-from-local skill dialog"`

---

## Task 6: Deploy + live verify

- [ ] **Step 1: Confirm sync + push.** `git fetch origin && git log --oneline main..origin/main` (expect empty). `git push origin main`.
- [ ] **Step 2: Run the VPS deploy.** `ssh ubuntu@45.89.234.110 'cd ~/hermit-ui && ./scripts/vps-deploy.sh'`. Expect: `prisma migrate deploy` applies `add_marketplace`, `next build` succeeds, dashboard restarts, healthcheck `OK — dashboard HTTP 200 — deployed <sha>`.
- [ ] **Step 3: Live smoke.** Confirm `curl -s -o /dev/null -w '%{http_code}' https://dash.swaylab.ai/market/skills` → 200. (UI behind auth; a 200 HTML shell is the check. Functional click-through — sidebar switch, publish a skill, see it listed, open detail — is the manual acceptance; note that the dashboard login wall blocks headless UI testing per token-safety.)

**A is done when:** sidebar flips Dashboard⇄Market; `/market/skills` + `/market/templates` render; Publish lists local skills and publishing one makes it appear in the market list with `v1` + an openable SKILL.md detail; re-publishing identical content is a no-op, changed content bumps to `v2`.

---

## Self-review

- **Spec coverage (capability 1):** sidebar mode-switch ✓ (Task 3). Browse skills/templates + versions ✓ (Tasks 2, 4). Data model ✓ (Task 1). Seed publish ✓ (Tasks 2, 5). Capabilities 2/3 (install/uninstall), 4 (import), 5 (templates) are Phases B/C/D — out of scope here, by design.
- **Type consistency:** `Ref = { path; content }` used in router + detail. `publishSkillFromLocal` input shape matches the Task 5 mutate call (`source:'global'`). `latestVersion` is a numeric string bumped via `parseInt`. `market.*` procedure names match page `useQuery`/`useMutation` calls.
- **No placeholders:** every code step is concrete; UI JSX detail (card chrome, modal layout) follows the cited existing patterns (`skills/page.tsx`, `file-detail.tsx`) rather than being re-spelled.
- **Gateway:** untouched — Phase A is dashboard-only; deploy skips the `pm2` gateway restart.
