-- APNs device registry for the native iOS shell (docs/ios-shell-design.md).
--
-- One row per (device token, machine): the phone registers its token once per
-- keyring entry, so a device holding several machine keys is subscribed to all
-- of them. Re-registration on every app launch is an upsert against the unique
-- pair, so tokens never accumulate duplicates.
--
-- Cascade on machine delete: a removed machine's device rows are dead weight —
-- there is nothing left to notify about.

CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'ios',
    -- 'sandbox' (Xcode-installed dev build) vs 'production' (TestFlight/App Store).
    -- Reported by the app from its embedded provisioning profile; sending to the
    -- wrong APNs host returns BadDeviceToken, so it can't be inferred here.
    "apnsEnv" TEXT NOT NULL DEFAULT 'sandbox',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushDevice_token_machineId_key" ON "PushDevice" ("token", "machineId");

CREATE INDEX "PushDevice_machineId_idx" ON "PushDevice" ("machineId");

ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
