// Bark transport — iOS push with no app to develop and no Apple Developer account.
//
// Bark (https://github.com/Finb/Bark) is a free, open-source App Store app whose
// entire job is to turn an HTTP request into a notification on your phone. You
// install it, it shows you a device key, and pushing is one POST. That is the whole
// integration: zero client code on our side, nothing to sign, nothing to renew.
//
// WHY IT NEEDS NO SERVER-SIDE SECRET
// The device key is the credential — whoever holds it can push to that phone, and
// nobody else can. So unlike APNs (team key) or Web Push (VAPID keypair) there is
// no env to configure and `isConfigured()` is unconditionally true. The flip side:
// treat the key like a password. It is stored in PushDevice.token exactly as an
// APNs token is.
//
// SELF-HOSTING
// `barkServer` points at a private bark-server (`docker run finab/bark-server`),
// null means the public https://api.day.app. Self-hosting still needs no Apple
// account: bark-server embeds Bark's own APNs auth key for the `me.fin.bark`
// topic. Worth doing here, because the default server would otherwise see agent
// chat previews in plaintext.
//
// API contract (verified against bark-server route_push.go):
//   POST /push  {"device_key": "...", ...}
//   200 → {"code":200,"message":"success"}
//   400 → device key empty, or "failed to get device token: ..." = key unknown
//   500 → "push failed: ..." = APNs itself refused; transient, keep the row
// See docs/no-app-push-design.md.

import type { PushDeviceRow, Transport, TransportPayload, TransportResult } from './transport';

/** Bark's public relay. Overridden per-device by PushDevice.barkServer. */
export const DEFAULT_BARK_SERVER = 'https://api.day.app';

// ── registration input ──────────────────────────────────────────────────────

/**
 * Device keys are `shortuuid.New()` on the server side — 22 base57 characters.
 * The range is kept loose so a self-hosted server that mints them differently
 * still works; the point is to reject things that are obviously not a key, not
 * to mirror one implementation's alphabet.
 */
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A raw APNs device token: 64 lowercase hex characters.
 *
 * The Bark app shows this right under the device Key, labelled 「设备Token」, and
 * it is the more official-looking of the two — so it gets pasted here. It is not
 * a key and never will be: bark-server looks Keys up in its own database, so a
 * token registers cleanly, fails the first send with "failed to get device
 * token", and is then reaped. From the outside that is indistinguishable from
 * push being broken, which is exactly what happened once already.
 *
 * Only checked on BARE input. A 64-hex string arriving as the path segment of a
 * pasted URL came from the app's URL field, so it really is that server's key —
 * which is also the escape hatch for anyone with a custom key of this shape.
 */
const APNS_TOKEN_RE = /^[0-9a-f]{64}$/i;

export type BarkParse =
  | { ok: true; deviceKey: string; server: string | null }
  | { ok: false; reason: 'empty' | 'bad-key' | 'bad-server' | 'apns-token' };

/**
 * Turn whatever the user pasted into a (key, server) pair.
 *
 * This accepts the FULL URL as well as a bare key, because the full URL is what
 * the Bark app's copy button actually produces — its home screen shows
 * `https://api.day.app/<key>/推送内容` and hands you the lot. Requiring people to
 * mentally slice the key out of that is a papercut that reads, from their side,
 * as "registration silently didn't work".
 *
 * The key is the FIRST path segment, never the last: Bark's own routes are
 * `/:key/:body`, `/:key/:title/:body` and `/:key/:title/:subtitle/:body`, so the
 * last segment is usually the placeholder body text.
 *
 * A pasted URL also tells us the server, which is exactly what a self-hoster
 * would otherwise have to type into the second field by hand.
 */
export function parseBarkTarget(input: string, explicitServer?: string | null): BarkParse {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty' };

  let server: string | null = null;
  if (explicitServer && explicitServer.trim()) {
    const s = normalizeServer(explicitServer);
    if (s === undefined) return { ok: false, reason: 'bad-server' };
    server = s;
  }

  // Bare key — but catch the device Token first; it also satisfies KEY_RE.
  if (APNS_TOKEN_RE.test(raw)) return { ok: false, reason: 'apns-token' };
  if (KEY_RE.test(raw)) return { ok: true, deviceKey: raw, server };

  // Full URL.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'bad-key' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'bad-key' };

  const first = url.pathname.split('/').filter(Boolean)[0];
  if (!first) return { ok: false, reason: 'bad-key' };
  let key: string;
  try {
    key = decodeURIComponent(first);
  } catch {
    return { ok: false, reason: 'bad-key' };
  }
  if (!KEY_RE.test(key)) return { ok: false, reason: 'bad-key' };

  // An explicitly typed server wins; otherwise the pasted URL's own origin is it.
  return { ok: true, deviceKey: key, server: server ?? normalizeServer(url.origin) ?? null };
}

/** `null` = the public default, `undefined` = not a usable http(s) base URL. */
function normalizeServer(s: string): string | null | undefined {
  const t = s.trim().replace(/\/+$/, '');
  if (!t) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  // Storing the default explicitly would be a lie the day the default changes.
  return u.origin === DEFAULT_BARK_SERVER ? null : u.origin;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Absolute origin the tap-through URL is built against. Bark opens it in Safari
 * (an https link can't be routed to an installed PWA without a native app to own
 * the universal link), so this must be the public dashboard URL, not localhost.
 */
function publicOrigin(): string {
  return (process.env.PUSH_PUBLIC_ORIGIN || 'https://dash.swaylab.ai').replace(/\/+$/, '');
}

/**
 * Bark's interruption levels. `timeSensitive` is the one that pierces a Focus
 * mode — and since the server no longer filters by time of day at all, this is
 * the ONLY say we get in whether a notification interrupts. The phone decides the
 * rest. `critical` is deliberately NOT used: it overrides the mute switch and
 * needs a volume, which is more than an agent waiting on a prompt deserves.
 */
function level(payload: TransportPayload): 'timeSensitive' | 'active' {
  return payload.urgent ? 'timeSensitive' : 'active';
}

/**
 * Notification Center grouping. One group per event kind rather than per session:
 * the collapse key already guarantees a session occupies a single slot, so
 * grouping by kind is what actually makes the stack readable ("3 cron failures").
 */
function group(payload: TransportPayload): string {
  return `Hermit · ${payload.kind}`;
}

export const barkTransport: Transport = {
  platform: 'bark',

  // No server-side credential exists to be missing — see the header.
  isConfigured: () => true,

  async send(device: PushDeviceRow, payload: TransportPayload): Promise<TransportResult> {
    const base = (device.barkServer || DEFAULT_BARK_SERVER).replace(/\/+$/, '');

    const body = JSON.stringify({
      device_key: device.token,
      title: payload.title,
      body: payload.body,
      // Same id replaces the existing notification instead of stacking — Bark's
      // equivalent of apns-collapse-id, and the reason our collapseKey semantics
      // survive this transport unchanged.
      id: payload.collapseKey.slice(0, 64),
      group: group(payload),
      level: level(payload),
      url: `${publicOrigin()}${payload.path}`,
      // Keep it in Bark's own history, so a notification cleared by accident is
      // still recoverable on the phone.
      isArchive: '1',
    });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
        signal: ac.signal,
      });
      const text = await res.text().catch(() => '');
      if (res.status === 200) return { ok: true, dead: false };
      return {
        ok: false,
        dead: isDeadKeyResponse(res.status, text),
        detail: `${res.status} ${text.slice(0, 160)}`.trim(),
      };
    } catch (e) {
      // Network error / timeout — never fatal, push is not on a critical path.
      return { ok: false, dead: false, detail: String(e).slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * Did Bark tell us this key is not a device?
 *
 * Narrow on purpose. bark-server answers 400 for both "device key is empty" (our
 * bug) and "failed to get device token" (the key really is unknown), and 500 for
 * an APNs-side failure that will likely succeed next time. Only the second is a
 * reason to delete someone's registration, so match its message rather than the
 * bare status.
 */
export function isDeadKeyResponse(status: number, body: string): boolean {
  return status === 400 && /failed to get device token/i.test(body);
}
