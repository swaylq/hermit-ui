-- Global memory: a single shared note (id 'global') loaded by every agent via
-- each machine's ~/.claude/CLAUDE.md. Prisma manages updatedAt via @updatedAt.
CREATE TABLE "GlobalMemory" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "content" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GlobalMemory_pkey" PRIMARY KEY ("id")
);
