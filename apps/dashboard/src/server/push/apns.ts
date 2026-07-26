// Minimal APNs client — token-based auth (JWT ES256) over HTTP/2, zero dependencies.
//
// Everything APNs needs is in Node's stdlib: `node:crypto` signs the ES256 JWT
// (P-256 ECDSA, IEEE-P1363 signature encoding — the JOSE format, NOT the DER
// default), `node:http2` carries the request. A push library would add a
// dependency that rots for ~120 lines of value.
//
// Config comes from env; if any piece is missing the whole push subsystem no-ops
// (see isConfigured) so local dev and a not-yet-provisioned VPS both stay quiet
// instead of throwing on every gateway write.
//
//   APNS_KEY_P8     full text of the .p8 auth key (BEGIN PRIVATE KEY …)
//   APNS_KEY_ID     10-char Key ID from the Apple developer portal
//   APNS_TEAM_ID    10-char Team ID
//   APNS_BUNDLE_ID  e.g. ai.swaylab.hermit  (becomes the apns-topic)
//
// The .p8 is a private key and must never reach git — it lives in the `secret`
// store and is materialised into apps/dashboard/.env on the VPS.

import crypto from 'node:crypto';
import http2 from 'node:http2';

export type ApnsEnv = 'sandbox' | 'production';

const HOSTS: Record<ApnsEnv, string> = {
  // Xcode-installed development builds register against sandbox; TestFlight and
  // App Store builds against production. The token looks identical either way —
  // sending to the wrong host just returns BadDeviceToken.
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};

// APNs requires the auth token to be refreshed at least hourly and rejects
// refreshes more often than every 20 minutes. 50 minutes sits safely between.
const JWT_TTL_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ApnsConfig {
  keyP8: string;
  keyId: string;
  teamId: string;
  bundleId: string;
}

function readConfig(): ApnsConfig | null {
  const keyP8 = process.env.APNS_KEY_P8;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!keyP8 || !keyId || !teamId || !bundleId) return null;
  // The .p8 survives a round-trip through a single-line .env as literal "\n".
  return { keyP8: keyP8.replace(/\\n/g, '\n'), keyId, teamId, bundleId };
}

export function isConfigured(): boolean {
  return readConfig() !== null;
}

// ── JWT ─────────────────────────────────────────────────────────────────────

/**
 * Mint a fresh APNs provider token: an ES256 JWS over `{iss: team, iat: now}`
 * with the key id in the header. Exported so the signing format can be verified
 * against a throwaway key in tests — getting it wrong yields InvalidProviderToken
 * from APNs and nothing more diagnostic than that.
 */
export function mintAuthToken(cfg: ApnsConfig, at: number = Date.now()): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${b64({ alg: 'ES256', kid: cfg.keyId })}.${b64({
    iss: cfg.teamId,
    iat: Math.floor(at / 1000),
  })}`;
  // dsaEncoding ieee-p1363 = the raw r||s pair JWS wants. Node's default is DER,
  // which APNs rejects with InvalidProviderToken — a genuinely obscure failure.
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey(cfg.keyP8),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${sig.toString('base64url')}`;
}

let cachedJwt: { token: string; issuedAt: number } | null = null;

function authToken(cfg: ApnsConfig): string {
  const now = Date.now();
  if (cachedJwt && now - cachedJwt.issuedAt < JWT_TTL_MS) return cachedJwt.token;
  const token = mintAuthToken(cfg, now);
  cachedJwt = { token, issuedAt: now };
  return token;
}

/** Drop the cached JWT (used when APNs reports ExpiredProviderToken). */
function invalidateJwt() {
  cachedJwt = null;
}

// ── HTTP/2 sessions (one long-lived connection per environment) ─────────────
// APNs explicitly asks providers to hold connections open rather than reconnect
// per push. Sessions are lazily created and dropped on close/error so the next
// send reconnects.
const sessions = new Map<ApnsEnv, http2.ClientHttp2Session>();

function connection(env: ApnsEnv): http2.ClientHttp2Session {
  const existing = sessions.get(env);
  if (existing && !existing.closed && !existing.destroyed) return existing;

  const session = http2.connect(HOSTS[env]);
  session.on('error', () => sessions.delete(env));
  session.on('close', () => sessions.delete(env));
  // Nothing else keeps the event loop busy for this socket; don't hold the
  // process open on its account.
  session.unref();
  sessions.set(env, session);
  return session;
}

/** Close all APNs connections (tests / shutdown). */
export function closeConnections(): void {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}

export interface ApnsPayload {
  title: string;
  body: string;
  /** In-app deep link, delivered alongside the alert. */
  path: string;
  /** Lock-screen identity — same key replaces rather than stacks. */
  collapseKey: string;
  /** Drives the app icon badge; omit to leave the badge alone. */
  badge?: number;
}

export interface ApnsResult {
  status: number;
  /** APNs `reason` string on failure, e.g. BadDeviceToken / Unregistered. */
  reason?: string;
}

/**
 * Deliver one notification. Never throws — a transport failure is reported as
 * status 0 so callers can treat "push failed" as unremarkable; push is never on
 * a critical path.
 */
export async function sendApns(
  deviceToken: string,
  env: ApnsEnv,
  payload: ApnsPayload,
): Promise<ApnsResult> {
  const cfg = readConfig();
  if (!cfg) return { status: 0, reason: 'NotConfigured' };

  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
      'thread-id': payload.collapseKey,
      ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
    },
    path: payload.path,
  });

  const result = await request(cfg, deviceToken, env, payload.collapseKey, body);
  // A JWT that aged out mid-flight: refresh once and retry, otherwise every push
  // for the next 50 minutes would fail the same way.
  if (result.reason === 'ExpiredProviderToken') {
    invalidateJwt();
    return request(cfg, deviceToken, env, payload.collapseKey, body);
  }
  return result;
}

function request(
  cfg: ApnsConfig,
  deviceToken: string,
  env: ApnsEnv,
  collapseKey: string,
  body: string,
): Promise<ApnsResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ApnsResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    let req: http2.ClientHttp2Stream;
    try {
      req = connection(env).request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${authToken(cfg)}`,
        'apns-topic': cfg.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        // Max 64 bytes; keys are cuids/machine ids so this is comfortable.
        'apns-collapse-id': collapseKey.slice(0, 64),
        'content-type': 'application/json',
      });
    } catch (e) {
      return done({ status: 0, reason: `connect: ${String(e)}` });
    }

    let status = 0;
    let raw = '';
    req.setEncoding('utf8');
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      done({ status: 0, reason: 'Timeout' });
    });
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('error', (e) => done({ status: 0, reason: String(e) }));
    req.on('end', () => {
      // 200 has an empty body; failures carry {"reason":"..."}.
      let reason: string | undefined;
      if (raw) {
        try {
          reason = (JSON.parse(raw) as { reason?: string }).reason;
        } catch {
          reason = raw.slice(0, 200);
        }
      }
      done({ status, reason });
    });
    req.end(body);
  });
}

/** Token-level failures that mean "this device is gone" — prune the row. */
export function isDeadToken(r: ApnsResult): boolean {
  return (
    r.reason === 'Unregistered' || r.reason === 'BadDeviceToken' || r.reason === 'DeviceTokenNotForTopic'
  );
}
