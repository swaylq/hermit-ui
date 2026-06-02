# Deploying hermit-ui to a VPS

## Routine deploys (git pull) — current method

Since **2026-06-02** the repo is public at **https://github.com/swaylq/hermit-ui** and
the VPS deploys by **pulling from GitHub**, not by rsync from the Mac.

**The two-step flow:**

1. **On the Mac** (source of truth — the gateway runs here): commit and push.
   ```bash
   cd /Users/mac/claudeclaw/asst/hermit-ui
   git add -A && git commit -m "…" && git push
   # if gateway code changed, restart it locally (gateway runs on the Mac):
   pm2 restart hermit-ui-gateway
   ```
2. **On the VPS** (hosts the dashboard only): pull + rebuild + restart, one command.
   ```bash
   ssh ubuntu@45.89.234.110 -- '~/hermit-ui/scripts/vps-deploy.sh'
   ```

`scripts/vps-deploy.sh` runs: `git pull --ff-only` → (only if deps changed) `npm install`
→ (only if `prisma/` changed) `migrate deploy` + `generate` → `next build` → `pm2 restart
hermit-ui-dashboard` → health check on `:4101`. It **builds before restarting**, so a failed
build leaves the live dashboard untouched. No-op when there are no new commits (`--force`
rebuilds anyway).

**Preserved across every pull** (gitignored, never overwritten): `apps/*/.env` (the VPS
`DATABASE_URL` + `PRISMA_QUERY_ENGINE_LIBRARY`), `node_modules/`, `.next/`, and
`apps/dashboard/src/generated/` (the debian Prisma engine).

### One-time VPS git setup (done 2026-06-02 — recorded for rebuilds)

The VPS checkout `~/hermit-ui` tracks `origin` over **anonymous HTTPS** (a public repo
needs no credentials). Two repo-local overrides were required because the box was set up
for the now-**suspended `voidborne-d`** account:

- the global `~/.gitconfig` has `url.git@github.com:.insteadOf = https://github.com/`,
  which rewrites every GitHub URL to SSH — and the box's SSH key is voidborne-d's, so the
  push/pull fails with *"account suspended"*;
- so a longer-prefix local override keeps swaylq URLs on HTTPS, and the credential helper
  is blanked so no stale token is presented:

```bash
git -C ~/hermit-ui config --local url.https://github.com/swaylq/.insteadOf https://github.com/swaylq/
git -C ~/hermit-ui config --local credential.helper ""
git -C ~/hermit-ui remote set-url origin https://github.com/swaylq/hermit-ui.git
```

To re-create the checkout from scratch: `cd ~ && git clone https://github.com/swaylq/hermit-ui.git`
(apply the two overrides above), then write `apps/dashboard/.env` (see §4) and `npm install`.

---

## Historical: the original rsync cutover (2026-05-25)

> The sections below document the **one-time** migration from `asst-dashboard` to
> hermit-ui via rsync. Kept for the Postgres / Caddy / seed-machine details and the
> hard-won pitfalls. **Routine deploys now use git pull (above), not rsync.**

> **2026-05-25 — initial cutover done.** `dash.swaylab.ai` now serves hermit-ui from VPS:4101. Three notes for next time:
> - Production asst-dashboard was on `:4180`, **not** `:4100` (4100 hosts a different Clerk-authed next app — leave it alone). Caddy block was `dash.swaylab.ai:8443 → localhost:4180`.
> - DB role + password live in `~/asst-dashboard/.vps-pgpass` on VPS; the role name is `asst_dashboard` (not `ubuntu`). For `pg_dump`, use `sudo -u postgres pg_dump asst_dashboard`.
> - sudo prints `unable to resolve host japan-dev` warnings (no /etc/hosts entry). Harmless — commands still run.

Target shape after this guide:

- `dash.swaylab.ai` → VPS `127.0.0.1:4101` (hermit-ui-dashboard, pm2-managed)
- Postgres `asst_dashboard` (or fresh `hermit_ui`) hosts the schema; gateway pushes from Mac
- Old `asst-dashboard` pm2 process stopped + archived

This is a destructive cutover. Run the smoke pass below (and let it sit overnight at minimum) before flipping production DNS.

## 0. Prereqs on VPS

```bash
# already there per TOOLS.md, but verify:
ssh ubuntu@45.89.234.110 -- 'which node tmux pm2 caddy psql && node --version'
# expected: node ≥ 20, tmux, pm2 9.x, caddy 2.x, psql client
```

## 1. Stage hermit-ui on VPS

From Mac:

```bash
# Mac → VPS rsync, exclude noise. NOTE the leading slashes on /agents/ and
# /_research/ — that anchors them to the repo root so the deeper
# apps/dashboard/src/app/api/sync/agents/ route directory isn't ALSO excluded
# (it would be if you wrote --exclude='agents/'). Also exclude .env files
# so the Mac dev creds don't clobber the VPS-only DATABASE_URL.
rsync -az --delete \
  --exclude=node_modules --exclude=.next --exclude=.git \
  --exclude='apps/*/logs' --exclude='/_research/' --exclude='/agents/' \
  --exclude='apps/*/.env' --exclude='apps/*/src/generated' \
  --exclude='.playwright-mcp' --exclude='*.tgz' \
  /Users/mac/claudeclaw/asst/hermit-ui/ \
  ubuntu@45.89.234.110:/home/ubuntu/hermit-ui/
```

`/agents/` is intentionally excluded — the gateway running on the Mac stays the authoritative source of agent state. The VPS dashboard only hosts the web UI + DB + receives gateway POSTs.

**Pitfall (2026-05-29 cron deploy):** the rsync above now uses `--delete` + excludes `apps/*/src/generated`. Two hard lessons:
- **Without `--delete`**, files DELETED in the source (routes/components removed during a refactor) linger on the VPS and break `next build` with stale-import errors. `--delete` makes the VPS mirror the source.
- **`src/generated` MUST be excluded** — it holds the platform-specific Prisma query engine (`libquery_engine-debian-openssl-3.0.x.so.node`). Rsyncing the Mac's copy over it clobbers the debian binary, then `prisma generate` won't even start because `PRISMA_QUERY_ENGINE_LIBRARY` (in the VPS `.env`) points at the now-missing file. Recovery: `rm -rf src/generated/prisma` then regenerate with the env var BLANKED so generate doesn't try to resolve it: `PRISMA_QUERY_ENGINE_LIBRARY= node ../../node_modules/prisma/build/index.js generate`, then migrate/build normally.

**Pitfall (2026-05-25 cutover):** initial deploy used `--exclude='agents/'` without the leading slash. rsync matched the pattern at EVERY level, so it ate `apps/dashboard/src/app/api/sync/agents/route.ts` along with the workspace-level `agents/` dir. Result: `/api/sync/agents` returned 404 on the VPS while every other sync route worked. Fix: anchor with leading slash + always re-run `next build` after rsync repairs.

**Pitfall (same cutover):** the second rsync overwrote VPS `apps/dashboard/.env` with Mac dev creds (`postgresql://mac@localhost/…`), causing Prisma "Authentication failed for role `mac`" 500s. Fix above: add `--exclude='apps/*/.env'`. Either way, after any rsync, sanity-check the env on VPS before restarting pm2.

## 2. Install deps + build on VPS

```bash
ssh ubuntu@45.89.234.110 << 'EOF'
cd ~/hermit-ui
npm install --no-audit --no-fund
cd apps/dashboard
node ../../node_modules/next/dist/bin/next build
EOF
```

Build artifacts land in `apps/dashboard/.next/`.

## 3. Postgres setup

Pick one:

**Option A — reuse `asst_dashboard` (matches the dev DB).** Schema is identical to local since we ran the same migrations.

```bash
ssh ubuntu@45.89.234.110 -- 'pg_dump asst_dashboard | gzip > ~/db-backups/asst_dashboard-pre-hermit-ui-$(date +%Y%m%d).sql.gz'
ssh ubuntu@45.89.234.110 << 'EOF'
cd ~/hermit-ui/apps/dashboard
DATABASE_URL='postgresql://...local creds...' \
  node ../../node_modules/prisma/build/index.js migrate deploy
EOF
```

**Option B — fresh `hermit_ui` DB.** Cleaner, but the gateway needs `DASHBOARD_URL` + `ASST_KEY` re-seeded for the new machine row.

```bash
ssh ubuntu@45.89.234.110 -- 'createdb hermit_ui'
# adjust apps/dashboard/.env DATABASE_URL on the VPS, then migrate deploy
```

## 4. Env on VPS

`apps/dashboard/.env` (gitignored — write manually):

```env
DATABASE_URL="postgresql://mac@localhost:5432/asst_dashboard?schema=public"
PORT=4101
NODE_ENV=production
HERMIT_UPLOAD_DIR=/var/hermit-ui/uploads
# REQUIRED: bypasses Next.js's broken bundling of Prisma's custom-output engine
# search paths. Without this, runtime fails with "Prisma Client could not locate
# the Query Engine for runtime debian-openssl-3.0.x" after any pm2 restart.
PRISMA_QUERY_ENGINE_LIBRARY=/home/ubuntu/hermit-ui/apps/dashboard/src/generated/prisma/libquery_engine-debian-openssl-3.0.x.so.node
```

```bash
ssh ubuntu@45.89.234.110 << 'EOF'
sudo mkdir -p /var/hermit-ui/uploads
sudo chown ubuntu:ubuntu /var/hermit-ui/uploads
chmod 755 /var/hermit-ui/uploads
EOF
```

## 5. Seed a machine + grab the X-Asst-Key

```bash
ssh ubuntu@45.89.234.110 << 'EOF'
cd ~/hermit-ui/apps/dashboard
node ../../node_modules/.bin/tsx scripts/seed-machine.ts hermit-ui-prod
EOF
# prints the X-Asst-Key once — STORE IT in 1Password / Keychain
```

That key goes into the **Mac-side** `apps/gateway/.env` (replacing the dev key) so the local gateway pushes to the VPS dashboard:

```env
DASHBOARD_URL=https://dash.swaylab.ai
AGENTS_ROOT=/Users/mac/claudeclaw
ASST_KEY=<paste from seed-machine.ts output>
```

`AGENTS_ROOT` switches from `hermit-ui/agents/` (dev) back to `/Users/mac/claudeclaw/` (real agents).

## 6. pm2 start on VPS (staging port, NOT prod URL yet)

```bash
ssh ubuntu@45.89.234.110 << 'EOF'
cd ~/hermit-ui/apps/dashboard
pm2 start ecosystem.config.cjs
pm2 save
EOF
```

`hermit-ui-dashboard` is now serving on `127.0.0.1:4101` on the VPS, alongside the still-running `asst-dashboard` on `4100`.

## 7. Caddy staging route — `dash-staging.swaylab.ai`

Add to `/etc/caddy/Caddyfile` on the VPS:

```caddy
dash-staging.swaylab.ai {
  reverse_proxy 127.0.0.1:4101
  encode gzip zstd
}
```

```bash
ssh ubuntu@45.89.234.110 -- 'sudo caddy reload --config /etc/caddy/Caddyfile'
```

DNS: add `dash-staging.swaylab.ai` A-record → `45.89.234.110`.

## 8. Smoke pass

From your laptop / phone:

- Open `https://dash-staging.swaylab.ai`
- Log in with the X-Asst-Key from step 5
- Verify `/agents` shows every entry from `~/claudeclaw/*` (Mac gateway pushes these)
- Open a chat with a test agent, send a message, verify the reply streams back
- Paste a screenshot into the composer, verify it renders inline
- Let it sit overnight — collect anything weird

## 9. Cutover — flip `dash.swaylab.ai` from 4100 → 4101

Once smoke passes, swap the production block in `/etc/caddy/Caddyfile`:

```diff
 dash.swaylab.ai {
-  reverse_proxy 127.0.0.1:4100
+  reverse_proxy 127.0.0.1:4101
   encode gzip zstd
 }
```

```bash
ssh ubuntu@45.89.234.110 -- 'sudo caddy reload --config /etc/caddy/Caddyfile'
```

Then stop the old asst-dashboard:

```bash
ssh ubuntu@45.89.234.110 -- 'pm2 stop asst-dashboard && pm2 save'
```

## 10. Rollback (if cutover goes bad)

```bash
# 1. Revert Caddy block to 127.0.0.1:4100
ssh ubuntu@45.89.234.110 -- 'sudo caddy reload'

# 2. Bring asst-dashboard back
ssh ubuntu@45.89.234.110 -- 'pm2 start asst-dashboard && pm2 save'

# 3. (Optional) hermit-ui can stay running on 4101 for the next attempt
```

The chat history is in the postgres DB, so rollback doesn't drop user data — both dashboards read the same rows.

## 11. Archive (after a clean week)

```bash
ssh ubuntu@45.89.234.110 -- 'pm2 delete asst-dashboard && pm2 save'
ssh ubuntu@45.89.234.110 -- 'mv ~/asst-dashboard ~/asst-dashboard.deprecated'
```

Optionally drop the staging Caddy block + DNS once you're sure.
