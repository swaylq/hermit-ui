-- File Station: large-file delivery from the dashboard to a machine.
CREATE TABLE "FileTransfer" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "destPath" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "unzip" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "FileTransfer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FileTransfer_machineId_status_idx" ON "FileTransfer"("machineId", "status");
ALTER TABLE "FileTransfer" ADD CONSTRAINT "FileTransfer_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
