-- Global memory becomes PER-MACHINE (was a shared singleton, id 'global'). Drop
-- the singleton + recreate keyed by machineId with a FK to Machine. Content
-- entered under the old shared model is dropped — re-enter it per machine.
DROP TABLE "GlobalMemory";

CREATE TABLE "GlobalMemory" (
    "machineId" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GlobalMemory_pkey" PRIMARY KEY ("machineId")
);

ALTER TABLE "GlobalMemory"
    ADD CONSTRAINT "GlobalMemory_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
