// Web Push transport — notifications to the dashboard's own installed PWA, with
// no app to develop and no Apple Developer account.
//
// iOS 16.4+ implements the standard Push API for web apps added to the Home
// Screen. Apple's push relay accepts a plain VAPID keypair you generate yourself;
// unlike APNs there is no team key, no entitlement, no $99/year. Since
// dash.swaylab.ai is already an installed PWA (manifest.ts + public/sw.js), the
// user-facing install step is already done — this is purely a server-side gap.
//
// Zero dependencies, matching apns.ts: node:crypto has everything. `web-push`
// would pull in a JOSE stack to do what is ~120 lines of well-specified HKDF here.
//
//   RFC 8291  aes128gcm payload encryption (ECDH → HKDF → AES-128-GCM)
//   RFC 8188  the aes128gcm content-encoding framing the body sits in
//   RFC 8292  VAPID — the ES256 JWT that identifies us to the push service
//   RFC 8030  the Topic / Urgency / TTL request headers
//
// The encryption is verified against RFC 8291 §5's published test vector in
// webpush.test.ts — a round-trip test would only prove self-consistency, and a
// wrong info string is exactly the bug that passes self-consistency and then fails
// on every real device.
//
// Env (all three, or the transport no-ops):
//   VAPID_PUBLIC_KEY   base64url of the 65-byte uncompressed P-256 point
//   VAPID_PRIVATE_KEY  base64url of the 32-byte scalar
//   VAPID_SUBJECT      mailto: or https: contact URL, per RFC 8292 §2.1
//
// Generate a keypair with `npx tsx scripts/gen-vapid-keys.ts`. The private key is
// a secret: `secret` store, never git.
//
// KNOWN iOS CAVEAT, by design not by bug: a Home Screen web app that goes unopened
// long enough has its subscription dropped by the system, silently. That is why
// docs/no-app-push-design.md pairs this with Bark rather than replacing it.

import crypto from 'node:crypto';
import type { PushDeviceRow, Transport, TransportPayload, TransportResult } from './transport';

// ── config ──────────────────────────────────────────────────────────────────

export interface VapidConfig {
  /** base64url, 65-byte uncompressed point (0x04 || X || Y). */
  publicKey: string;
  /** base64url, 32-byte scalar. */
  privateKey: string;
  /** `mailto:you@example.com` — who the push service complains to. */
  subject: string;
}

function readConfig(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export function isConfigured(): boolean {
  return readConfig() !== null;
}

/** The public key the browser needs for `pushManager.subscribe`. Null if unset. */
export function publicKey(): string | null {
  return readConfig()?.publicKey ?? null;
}

/**
 * Mint a VAPID keypair. Used by scripts/gen-vapid-keys.ts, and by tests that need
 * a real P-256 pair without shipping one in the repo.
 */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    // The raw scalar can come back under 32 bytes when it has leading zeros;
    // every consumer expects a fixed width, so pad rather than hand out a short key.
    privateKey: leftPad(ecdh.getPrivateKey(), 32).toString('base64url'),
  };
}

function leftPad(buf: Buffer, size: number): Buffer {
  if (buf.length >= size) return buf;
  return Buffer.concat([Buffer.alloc(size - buf.length), buf]);
}

// ── RFC 8291 payload encryption ─────────────────────────────────────────────

/** Single-record framing: plaintext is capped at rs − 16 (tag) − 1 (delimiter). */
const RECORD_SIZE = 4096;
const MAX_PLAINTEXT = RECORD_SIZE - 17;

const hmac = (key: Buffer, data: Buffer): Buffer =>
  crypto.createHmac('sha256', key).update(data).digest();

export interface EncryptOverrides {
  /** Ephemeral server key. Random per message in production; fixed in the RFC test. */
  asPrivate?: Buffer;
  /** 16-byte salt. Random per message in production; fixed in the RFC test. */
  salt?: Buffer;
}

/**
 * Encrypt one push payload for one subscription, producing the complete
 * `Content-Encoding: aes128gcm` body.
 *
 * The layout (RFC 8188 §2.1) is
 *   salt(16) ‖ rs(4, big-endian) ‖ idlen(1) ‖ keyid(=our ephemeral public, 65)
 *   ‖ AES-128-GCM(plaintext ‖ 0x02)
 * where 0x02 is the last-record delimiter — we always send exactly one record.
 */
export function encryptPayload(
  plaintext: Buffer,
  uaPublic: Buffer,
  authSecret: Buffer,
  overrides: EncryptOverrides = {},
): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) {
    throw new Error(`web push payload too large: ${plaintext.length} > ${MAX_PLAINTEXT}`);
  }

  const ecdh = crypto.createECDH('prime256v1');
  if (overrides.asPrivate) {
    // Node derives and stores the matching public point on set.
    ecdh.setPrivateKey(overrides.asPrivate);
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);
  const salt = overrides.salt ?? crypto.randomBytes(16);

  // RFC 8291 §3.3 — the auth secret salts an extra HKDF round, binding the
  // content key to this subscription and not merely to the ECDH pair.
  const prkKey = hmac(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPublic,
    asPublic,
  ]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));

  // RFC 8188 §2.2 — content encryption key and nonce off the salted PRK.
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'utf8')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'utf8')).subarray(0, 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);

  return Buffer.concat([header, asPublic, ciphertext]);
}

// ── RFC 8292 VAPID ──────────────────────────────────────────────────────────

/** 12 h. RFC 8292 caps `exp` at 24 h from now; half that leaves clock skew room. */
const JWT_TTL_S = 12 * 3600;
/** Re-mint a little before expiry rather than racing it. */
const JWT_REFRESH_MS = 11 * 3600 * 1000;

/**
 * Build the ES256 signing key from the raw VAPID pair. Node has no "raw scalar"
 * EC import, but it does import JWK — and x / y are just the two halves of the
 * public point we already have.
 */
function signingKey(cfg: VapidConfig): crypto.KeyObject {
  const pub = Buffer.from(cfg.publicKey, 'base64url');
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point');
  }
  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
      d: leftPad(Buffer.from(cfg.privateKey, 'base64url'), 32).toString('base64url'),
    },
    format: 'jwk',
  });
}

/**
 * Sign a VAPID JWT for one push-service origin. Exported so the signature format
 * can be verified in tests — an ES256 JWS wants the raw r‖s pair, and Node's
 * default DER encoding is silently rejected by push services (the same trap
 * apns.ts documents).
 */
export function mintVapidJwt(cfg: VapidConfig, audience: string, at: number = Date.now()): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${b64({ typ: 'JWT', alg: 'ES256' })}.${b64({
    aud: audience,
    exp: Math.floor(at / 1000) + JWT_TTL_S,
    sub: cfg.subject,
  })}`;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: signingKey(cfg),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${sig.toString('base64url')}`;
}

// One JWT per push-service origin (Apple, Mozilla, Google are separate audiences).
const jwtCache = new Map<string, { token: string; issuedAt: number }>();

function authorization(cfg: VapidConfig, endpoint: string): string {
  const audience = new URL(endpoint).origin;
  const now = Date.now();
  const hit = jwtCache.get(audience);
  if (hit && now - hit.issuedAt < JWT_REFRESH_MS) {
    return `vapid t=${hit.token}, k=${cfg.publicKey}`;
  }
  const token = mintVapidJwt(cfg, audience, now);
  jwtCache.set(audience, { token, issuedAt: now });
  return `vapid t=${token}, k=${cfg.publicKey}`;
}

/** Drop cached VAPID JWTs (tests / a rotated keypair). */
export function resetJwtCache(): void {
  jwtCache.clear();
}

// ── payload shape ───────────────────────────────────────────────────────────

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Narrow an untyped Json column into a subscription, or null if it isn't one. */
export function parseSubscription(v: unknown): WebPushSubscription | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof s.endpoint !== 'string') return null;
  if (typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return null;
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

/**
 * The message body, in Declarative Web Push shape (WebKit, Safari 18.4+).
 *
 * The `web_push: 8030` marker lets the browser render the notification ITSELF,
 * with no service worker execution — which on iOS is both the reliable path and
 * the fallback when the SW fails to run. Older iOS and every other browser ignore
 * the marker and take the same object through our sw.js `push` handler, so one
 * payload serves both without branching on user agent.
 *
 * `navigate` must be same-origin and inside the SW scope, hence the absolute URL
 * built from PUSH_PUBLIC_ORIGIN.
 */
export function buildPayload(payload: TransportPayload, origin: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      web_push: 8030,
      notification: {
        title: payload.title,
        body: payload.body,
        navigate: `${origin}${payload.path}`,
        // Same tag replaces rather than stacks — the Web Notification equivalent
        // of apns-collapse-id, keeping collapse semantics intact on this wire too.
        tag: payload.collapseKey,
        data: { path: payload.path, kind: payload.kind },
      },
    }),
    'utf8',
  );
}

function publicOrigin(): string {
  return (process.env.PUSH_PUBLIC_ORIGIN || 'https://dash.swaylab.ai').replace(/\/+$/, '');
}

/**
 * RFC 8030 §5.4 caps Topic at 32 characters from the URL-safe base64 alphabet.
 * Our collapse keys are longer than that and carry `-` separators, so hash rather
 * than truncate: same key in, same topic out, and no invalid-header rejections.
 */
export function topicFor(collapseKey: string): string {
  return crypto.createHash('sha256').update(collapseKey).digest('base64url').slice(0, 32);
}

// ── send ────────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000;

export const webPushTransport: Transport = {
  platform: 'web',
  isConfigured,

  async send(device: PushDeviceRow, payload: TransportPayload): Promise<TransportResult> {
    const cfg = readConfig();
    if (!cfg) return { ok: false, dead: false, detail: 'VAPID_* not configured' };

    const sub = parseSubscription(device.subscription);
    if (!sub) {
      // The row claims to be a web device but carries no usable subscription —
      // it can never work, so let the caller reap it.
      return { ok: false, dead: true, detail: 'malformed subscription' };
    }

    let body: Buffer;
    try {
      body = encryptPayload(
        buildPayload(payload, publicOrigin()),
        Buffer.from(sub.keys.p256dh, 'base64url'),
        Buffer.from(sub.keys.auth, 'base64url'),
      );
    } catch (e) {
      // Bad keys in the row, or an oversized payload. Neither is retryable, but
      // only the former is the device's fault — don't reap on our own bug.
      return { ok: false, dead: false, detail: `encrypt: ${String(e).slice(0, 120)}` };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          authorization: authorization(cfg, sub.endpoint),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          // How long the push service holds it for an offline device. A chat
          // reply from yesterday is noise; something you were blocked on is not.
          ttl: String(payload.urgent ? 86_400 : 21_600),
          urgency: payload.urgent ? 'high' : 'normal',
          topic: topicFor(payload.collapseKey),
        },
        body: new Uint8Array(body),
        signal: ac.signal,
      });

      // 201 is the spec'd success; 200/202 are seen in the wild.
      if (res.status >= 200 && res.status < 300) return { ok: true, dead: false };

      const text = await res.text().catch(() => '');
      return {
        ok: false,
        dead: isDeadSubscription(res.status),
        detail: `${res.status} ${text.slice(0, 160)}`.trim(),
      };
    } catch (e) {
      return { ok: false, dead: false, detail: String(e).slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * Statuses that mean the subscription is permanently gone: 404 the endpoint never
 * existed, 410 the user agent revoked it (PWA deleted, notifications turned off,
 * or iOS expiring one that went unopened). 429 and 5xx are transient — retrying
 * later is right, deleting the row is not.
 */
export function isDeadSubscription(status: number): boolean {
  return status === 404 || status === 410;
}
