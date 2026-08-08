// Mint a VAPID keypair for Web Push.
//
//   npx tsx scripts/gen-vapid-keys.ts
//
// Run once. The keypair identifies THIS server to push services; rotating it
// invalidates every existing subscription, so keep the private key in the
// `secret` store and put both into apps/dashboard/.env on the VPS.
//
// See src/server/push/webpush.ts and docs/no-app-push-design.md.

import { generateVapidKeys } from '../src/server/push/webpush';

const { publicKey, privateKey } = generateVapidKeys();

console.log(`
Add these to apps/dashboard/.env — VAPID_PRIVATE_KEY is a secret, treat it like
the APNs .p8 (never commit it):

VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}
VAPID_SUBJECT=mailto:you@example.com

VAPID_SUBJECT must be a mailto: or https: URL a push service can use to reach you
about a misbehaving server (RFC 8292 §2.1). Also set PUSH_PUBLIC_ORIGIN if the
dashboard is not at https://dash.swaylab.ai — notification tap-through URLs are
built from it.
`);
