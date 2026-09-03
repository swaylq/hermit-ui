-- Live Activities: one row per running Lock Screen / Dynamic Island activity.
--
-- The token here is per-ACTIVITY, not per-device (that one lives on PushDevice),
-- so a phone showing two sessions has two rows. Rows are created when the app
-- reports a token and removed when the activity ends or APNs reports the token
-- dead.
CREATE TABLE "LiveActivity" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "apnsEnv" TEXT NOT NULL DEFAULT 'sandbox',
    "lastSig" TEXT,
    "phase" TEXT,
    "phaseSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveActivity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LiveActivity_token_key" ON "LiveActivity"("token");
CREATE INDEX "LiveActivity_sessionId_idx" ON "LiveActivity"("sessionId");
CREATE INDEX "LiveActivity_machineId_idx" ON "LiveActivity"("machineId");

ALTER TABLE "LiveActivity" ADD CONSTRAINT "LiveActivity_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveActivity" ADD CONSTRAINT "LiveActivity_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The app-wide push-to-start token (iOS 17.2+), which lets the server raise an
-- activity on a phone whose app is not running. Nullable: older iOS versions and
-- non-iOS rows never have one.
ALTER TABLE "PushDevice" ADD COLUMN "liveActivityStartToken" TEXT;
