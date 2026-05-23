-- CreateTable
CREATE TABLE "Machine" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3),

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pid" INTEGER,
    "alive" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT,
    "contextTokens" INTEGER,
    "outputTokens" INTEGER,
    "lastActivity" TIMESTAMP(3),
    "transcriptPath" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "agentId" TEXT,
    "agentName" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'note',
    "title" TEXT,
    "message" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LaunchAgentRecord" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "scheduleKind" TEXT,
    "intervalSec" INTEGER,
    "calendarHour" INTEGER,
    "calendarMinute" INTEGER,
    "runAtLoad" BOOLEAN NOT NULL DEFAULT false,
    "keepAlive" BOOLEAN NOT NULL DEFAULT false,
    "running" BOOLEAN,
    "logPath" TEXT,
    "lastFire" TIMESTAMP(3),
    "programArgs" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaunchAgentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Machine_name_key" ON "Machine"("name");

-- CreateIndex
CREATE INDEX "Agent_machineId_idx" ON "Agent"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_machineId_name_key" ON "Agent"("machineId", "name");

-- CreateIndex
CREATE INDEX "Event_machineId_ts_idx" ON "Event"("machineId", "ts");

-- CreateIndex
CREATE INDEX "Event_agentId_ts_idx" ON "Event"("agentId", "ts");

-- CreateIndex
CREATE INDEX "LaunchAgentRecord_machineId_idx" ON "LaunchAgentRecord"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "LaunchAgentRecord_machineId_label_key" ON "LaunchAgentRecord"("machineId", "label");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaunchAgentRecord" ADD CONSTRAINT "LaunchAgentRecord_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
