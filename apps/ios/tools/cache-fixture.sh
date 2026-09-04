#!/usr/bin/env bash
# Drives the local chat cache — ChatCache.swift and SyncPlan.swift — with no
# simulator, no key and no network. About four seconds.
#
#     apps/ios/tools/cache-fixture.sh
#
# It runs both halves against tables generated from the WEB's implementations
# (tools/fixtures/*.json, written by apps/dashboard/scripts/gen-*-fixture.ts),
# measures the FTS5 trigram index against a linear scan on a Chinese corpus, and
# checks that rewriting or deleting a row leaves the index level with the table.
#
# Built for the host, not for iOS: everything under test is Foundation plus
# libsqlite3, and Apple ships the same SQLite on both. What the host CANNOT tell
# you is whether an older iOS's libsqlite3 has FTS5 compiled in — ChatCache
# creates the virtual table while opening, so that failure surfaces at open time
# on a real device rather than inside a query.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${TMPDIR:-/tmp}/hermit-cache-fixture"
mkdir -p "$OUT"

echo "building…"
swiftc -O \
  -o "$OUT/cache-fixture" \
  tools/cache-fixture/main.swift \
  Hermit/ChatCache.swift \
  Hermit/SyncPlan.swift \
  Shared/WebContract.swift

"$OUT/cache-fixture" "$PWD"
