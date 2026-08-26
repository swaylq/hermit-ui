-- Dismiss snooze for MachineAlert. A dismissed alert must stay dismissed while
-- its condition persists — without this, the sweep re-opens (and re-pushes) the
-- same (machine, kind) on its very next pass, and the × button is decorative.
ALTER TABLE "MachineAlert" ADD COLUMN "snoozedUntil" TIMESTAMP(3);
