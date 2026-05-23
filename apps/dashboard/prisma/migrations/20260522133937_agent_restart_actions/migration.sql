-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "restartRequestedAt" TIMESTAMP(3),
ADD COLUMN     "restartStartedAt" TIMESTAMP(3);
