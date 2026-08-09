-- Retire the idle-TTL reaper; archiving is the one mechanism now.
-- (docs/session-cleanup-design.md, docs/resource-governance-design.md)
--
-- The machine had two automatic session-lifecycle mechanisms with two different
-- thresholds and two different outcomes:
--
--   reaper (idleReapHours, 72h)  → hibernate: frees the process, leaves the
--                                  conversation in the sidebar looking normal
--   cleanup (cleanupIdleDays)    → archive: out of the sidebar, and asleep
--
-- The first one's outcome is a strict subset of the second's, so it only ever
-- produced a half-tidied state: 104 sessions across the fleet were asleep but
-- still sitting in the sidebar, which is exactly what a user reads as "the
-- cleanup didn't work". One mechanism now — the Brain's nightly dream and the
-- hourly sweep both archive, and archiving hibernates as part of archiving.

-- 1. Carry the dial over rather than losing it. 72h becomes 3 days, so every
--    machine keeps the memory behaviour it already had: this is the ONLY thing
--    standing between "sessions sleep after 3 days" and "sessions stay awake for
--    two weeks", and a null here would silently mean the latter.
UPDATE "Machine"
   SET "cleanupIdleDays" = COALESCE("cleanupIdleDays", GREATEST(1, ROUND("idleReapHours" / 24.0)::int))
 WHERE "idleReapHours" IS NOT NULL;

-- 2. Archive what the reaper had already put to sleep. These are the sessions the
--    user can see are asleep and still cluttering the list.
--
--    closedAt = now(), NOT hibernatedAt. The honest timestamp would be when it
--    actually went dormant, but closedAt also starts the recycle bin's "archived
--    and still untouched a month later" clock — dating these back would make
--    dozens of them bin-eligible the instant this migration lands, which is the
--    exact ladder-collapse the bin rung was fixed to avoid. Start the clock now.
UPDATE "ChatSession"
   SET "closedAt" = now()
 WHERE "hibernatedAt" IS NOT NULL
   AND "closedAt" IS NULL
   AND "trashedAt" IS NULL;

-- 3. The old dial is gone. Dropped rather than left in place: a config column the
--    UI no longer shows and no code reads is how someone sets a value and spends
--    an afternoon wondering why nothing happens. Its value was copied in step 1.
ALTER TABLE "Machine" DROP COLUMN "idleReapHours";
