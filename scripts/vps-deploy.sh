#!/usr/bin/env bash
#
# Deploy the hermit-ui dashboard on the VPS by pulling from GitHub.
#
# Usage (on the VPS):
#   ~/hermit-ui/scripts/vps-deploy.sh          # deploy only if there are new commits
#   ~/hermit-ui/scripts/vps-deploy.sh --force  # rebuild + restart even with no new commits
#
# Workflow this is the VPS half of:
#   Mac:  git push          (source of truth — the gateway runs on the Mac)
#   VPS:  this script        (pull -> install -> migrate -> generate -> build -> restart)
#
# Safe by design: builds BEFORE restarting, so a failed build leaves the running
# dashboard untouched. Gitignored files (apps/*/.env, node_modules, .next,
# apps/dashboard/src/generated) are never touched by the pull.
set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

echo "==> git pull --ff-only origin main"
before="$(git rev-parse HEAD)"
git pull --ff-only origin main
after="$(git rev-parse HEAD)"

if [ "$before" = "$after" ] && [ "$FORCE" -ne 1 ]; then
  echo "Already up to date ($after). Nothing to deploy. (use --force to rebuild)"
  exit 0
fi

# Decide what work the new commits actually need.
changed() { [ "$before" = "$after" ] || ! git diff --quiet "$before" "$after" -- "$@"; }

if [ "$FORCE" -eq 1 ] || changed package-lock.json 'apps/*/package.json' 'packages/*/package.json'; then
  echo "==> deps changed -> npm install"
  npm install --no-audit --no-fund
else
  echo "==> deps unchanged -> skip npm install"
fi

# Compute prisma-changed at the repo ROOT: changed()'s pathspecs resolve
# relative to cwd, so this MUST run before we cd into apps/dashboard — otherwise
# the pathspec doubles to apps/dashboard/apps/dashboard/prisma, matches nothing,
# and migrate/generate get silently skipped on a real schema change (the build
# then fails type-checking against a stale client). Use --force to recover if a
# prior failed deploy already pulled the prisma change.
prisma_changed=0
if [ "$FORCE" -eq 1 ] || changed apps/dashboard/prisma; then prisma_changed=1; fi

cd apps/dashboard

if [ "$prisma_changed" -eq 1 ]; then
  echo "==> prisma migrate deploy"
  node ../../node_modules/prisma/build/index.js migrate deploy
  # Blank PRISMA_QUERY_ENGINE_LIBRARY for generate: the .env points it at the
  # debian engine under src/generated; if that path is mid-rebuild, generate
  # fails trying to resolve it. Blanking lets generate recreate it cleanly.
  echo "==> prisma generate"
  PRISMA_QUERY_ENGINE_LIBRARY= node ../../node_modules/prisma/build/index.js generate
else
  echo "==> prisma schema unchanged -> skip migrate/generate"
fi

echo "==> next build"
node ../../node_modules/next/dist/bin/next build

echo "==> pm2 restart hermit-ui-dashboard"
pm2 restart hermit-ui-dashboard --update-env

echo "==> health check"
sleep 3
code="$(curl -fsS -o /dev/null -w '%{http_code}' http://localhost:4101/ || echo FAIL)"
if [ "$code" = "200" ]; then
  echo "OK — dashboard HTTP 200 — deployed $after"
else
  echo "WARN — dashboard health check returned '$code'. Check: pm2 logs hermit-ui-dashboard"
  exit 1
fi
