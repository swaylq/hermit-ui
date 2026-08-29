#!/usr/bin/env bash
# One-off backfill: drop `signature` from every stored thinking block.
#
# The code stopped writing the field in `dropStoredImageBytes` and stopped
# shipping it in `capMessageContent` (apps/dashboard/src/server/message-cap.ts,
# note 3). This removes what is already on disk: measured on the production DB
# 2026-08-29, 401 MB of the 3,182 MB ChatMessage table, in 99,988 blocks, 94% of
# which carry no reasoning text at all and therefore paint nothing.
#
# WHERE THIS MUST RUN: on the database host, as a user that can reach the
# `asst_dashboard` database — i.e. `ssh japan-dev`, not from a laptop and not
# from inside a gateway session. It is safe to interrupt and safe to re-run: a
# stripped row no longer matches the WHERE, so the script simply finds fewer
# rows next time and stops when it finds none.
#
# WHY RAW SQL AND NOT PRISMA — the load-bearing detail:
#
#   `ChatMessage.updatedAt` is `@updatedAt`. Any write through Prisma would bump
#   it on all ~100k rows, and updatedAt is exactly what `chat.syncProbe` reports
#   as each session's watermark and what `/api/chat/stream` polls as its change
#   signal. Bumping it would tell every browser that every session had changed —
#   a full prose re-sync of the whole machine, tens of MB per open tab — and
#   wake every live SSE stream at once. This UPDATE names only `content`, so
#   `updatedAt` keeps its value: Postgres does not fire Prisma's application-side
#   @updatedAt, and there is no database trigger on this column.
#
#   For the same reason nothing here touches ChatSession.lastMessageAt: an
#   unread-dot flip on 648 sessions is not a thing to do by accident.
#
# The rewrite itself is per-block and structural — `e - 'signature'` on thinking
# blocks only — so block count and block order are preserved by construction.
# Rehearsed read-only over 2,000 rows before first use: 0 rows changed block
# count, 0 changed type order, 0 kept a signature, 6,209 kB → 209 kB.
#
# Usage:
#   scripts/backfill-drop-thinking-signature.sh            # do it
#   DRY_RUN=1 scripts/backfill-drop-thinking-signature.sh  # count only, no writes
#   BATCH=1000 scripts/backfill-drop-thinking-signature.sh # bigger batches
set -euo pipefail

DB="${DB:-asst_dashboard}"
BATCH="${BATCH:-500}"
SLEEP="${SLEEP:-0.2}"     # breathing room for a 4-core box also serving the app
MAX_ROUNDS="${MAX_ROUNDS:-1000}"
DRY_RUN="${DRY_RUN:-}"

psql_() { sudo -n -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 -Atc "$1"; }

# The exact predicate used everywhere below. The `@>` containment is the cheap
# prefilter (it can use a GIN index if one is ever added); the EXISTS is the
# precise test, and is what makes the script idempotent — a stripped row stops
# matching, so re-running finds nothing.
WHERE_SQL="jsonb_typeof(content) = 'array'
       AND content @> '[{\"type\":\"thinking\"}]'::jsonb
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(content) e
                   WHERE e->>'type' = 'thinking' AND e ? 'signature')"

echo "== before =="
psql_ "SELECT 'rows to strip: ' || count(*) FROM \"ChatMessage\" WHERE $WHERE_SQL"
psql_ "SELECT 'table total:   ' || pg_size_pretty(pg_total_relation_size('\"ChatMessage\"'))"

if [ -n "$DRY_RUN" ]; then
  echo "DRY_RUN set — nothing written."
  exit 0
fi

total=0
for round in $(seq 1 "$MAX_ROUNDS"); do
  # LIMIT inside a CTE, then join back: keeps each transaction short so the
  # script never holds a long lock on a table the app is reading.
  n=$(psql_ "
    WITH batch AS (
      SELECT id FROM \"ChatMessage\"
      WHERE $WHERE_SQL
      ORDER BY id
      LIMIT $BATCH
    ), upd AS (
      UPDATE \"ChatMessage\" m
         SET content = (
               SELECT jsonb_agg(
                        CASE WHEN e->>'type' = 'thinking' THEN e - 'signature' ELSE e END
                        ORDER BY ord)
                 FROM jsonb_array_elements(m.content) WITH ORDINALITY AS t(e, ord))
        FROM batch
       WHERE m.id = batch.id
      RETURNING m.id)
    SELECT count(*) FROM upd")
  total=$((total + n))
  [ "$n" -eq 0 ] && break
  printf 'round %-4s stripped %-6s total %s\n' "$round" "$n" "$total"
  sleep "$SLEEP"
done

echo "== after =="
psql_ "SELECT 'rows left:     ' || count(*) FROM \"ChatMessage\" WHERE $WHERE_SQL"

# The UPDATEs left one dead tuple per row. Plain VACUUM (never FULL — that takes
# an ACCESS EXCLUSIVE lock and would stall the dashboard) returns the space to
# the table's own free space map, which is where the next weeks of inserts go.
echo "== vacuum =="
sudo -n -u postgres psql -d "$DB" -c 'VACUUM (VERBOSE false) "ChatMessage"'
psql_ "SELECT 'table total:   ' || pg_size_pretty(pg_total_relation_size('\"ChatMessage\"'))"
echo "done — $total rows stripped"
