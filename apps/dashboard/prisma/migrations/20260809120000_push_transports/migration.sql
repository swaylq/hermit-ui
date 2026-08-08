-- Push beyond APNs: the same PushDevice table now also holds Web Push
-- subscriptions and Bark device keys (docs/no-app-push-design.md).
--
-- Both new transports exist to get notifications onto an iPhone WITHOUT a paid
-- Apple Developer account, which the native shell in apps/ios requires for its
-- aps-environment entitlement.
--
-- The table shape barely moves, because `platform` was already here and `token`
-- was already the per-device identity — a Web Push endpoint URL and a Bark device
-- key both slot into it, keeping the (token, machineId) unique constraint doing
-- exactly the job it already did. Only the two genuinely transport-specific
-- fields are new, and both are nullable: every existing 'ios' row stays valid
-- with no backfill.

-- web only: { endpoint, keys: { p256dh, auth } }. The endpoint is duplicated into
-- `token` (the identity); the ECDH + auth secrets have nowhere else to live.
ALTER TABLE "PushDevice" ADD COLUMN "subscription" JSONB;

-- bark only: base URL of a self-hosted bark-server. NULL = the public
-- api.day.app. Per-device, not per-machine — a device key is only valid against
-- the server that issued it, so two phones may legitimately differ.
ALTER TABLE "PushDevice" ADD COLUMN "barkServer" TEXT;
