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
