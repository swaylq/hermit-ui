// Which wire a PushEvent leaves on.
//
// Everything upstream of here — the event builders, the 20 s chat debounce, quiet
// hours, the "you're already looking at it" check, the collapse identity — is
// transport-neutral and always was. Only the last hop knew about APNs. This module
// is that hop, generalised, so `index.ts` can fan out to a phone without caring
// whether the phone runs the native shell, an installed PWA, or Bark.
//
// Three transports, in the order you'd reach for them:
//
//   bark  — a free App Store app + one HTTP POST. No Apple Developer account, no
//           client code at all. The device key IS the credential, so it needs no
//           server-side secret and is therefore ALWAYS configured.
//   web   — Web Push (RFC 8030/8291/8292) to the dashboard's own installed PWA.
//           No Apple account either; needs a VAPID keypair in env. Best UX (our
//           icon, deep-links into the PWA) but iOS drops subscriptions that go
//           unopened for long enough — see docs/no-app-push-design.md.
//   ios   — the original native shell (apps/ios). Needs a PAID Apple Developer
//           account for the aps-environment entitlement; kept intact and working.
//
// They coexist on purpose: `web` and `bark` fail in uncorrelated ways, and a
// device registered on both simply gets the same collapse key on two wires.

import type { PushKind } from './types';
import { isConfigured as apnsConfigured, isDeadToken, sendApns, type ApnsEnv } from './apns';
import { barkTransport } from './bark';
import { webPushTransport } from './webpush';

export type Platform = 'ios' | 'web' | 'bark';

export const PLATFORMS: readonly Platform[] = ['ios', 'web', 'bark'] as const;

export function isPlatform(v: string): v is Platform {
  return (PLATFORMS as readonly string[]).includes(v);
}

/**
 * The subset of a PushDevice row a transport is allowed to read. Deliberately
 * narrow: a transport never sees the machine, so it cannot widen its own audience.
 */
export interface PushDeviceRow {
  id: string;
  platform: string;
  /** Transport-specific identity: APNs hex token | Bark device key | Web Push endpoint. */
  token: string;
  /** `ios` only. */
  apnsEnv: string;
  /** `web` only — { endpoint, keys: { p256dh, auth } }. */
  subscription: unknown;
  /** `bark` only — self-hosted base URL; null means the public api.day.app. */
  barkServer: string | null;
}

export interface TransportPayload {
  title: string;
  body: string;
  /** In-app path, e.g. `/chat?session=abc`. Always starts with `/`. */
  path: string;
  /** Notification identity — same key replaces rather than stacks. */
  collapseKey: string;
  kind: PushKind;
  /**
   * Should this cut through Focus / Do Not Disturb? True for exactly the kinds
   * that also ignore quiet hours (see suppress.ts) — being woken by an agent
   * stopped dead on a permission prompt is the point; "agent replied" is not.
   */
  urgent: boolean;
}

export interface TransportResult {
  ok: boolean;
  /**
   * This device is permanently gone (app deleted, subscription revoked, key
   * unknown to the Bark server). The caller drops the row rather than retrying it
   * forever. Must be false for anything that could be transient — a wrongly-dead
   * device silently stops receiving notifications until it re-registers.
   */
  dead: boolean;
  /** One-line diagnostic, logged when `ok` is false. */
  detail?: string;
}

export interface Transport {
  readonly platform: Platform;
  /** False when the server-side credentials this transport needs are absent. */
  isConfigured(): boolean;
  send(device: PushDeviceRow, payload: TransportPayload): Promise<TransportResult>;
}

/**
 * The native iOS shell, wrapped. `apns.ts` predates this interface and stays
 * exactly as it was — it is the one transport with a real device-fleet behind it
 * and its own tests, so the adapter lives here rather than churning that file.
 */
const apnsTransport: Transport = {
  platform: 'ios',
  isConfigured: apnsConfigured,
  async send(device, payload) {
    const r = await sendApns(device.token, device.apnsEnv as ApnsEnv, {
      title: payload.title,
      body: payload.body,
      path: payload.path,
      collapseKey: payload.collapseKey,
    });
    return {
      ok: r.status === 200,
      dead: isDeadToken(r),
      detail: r.status === 200 ? undefined : `${r.status} ${r.reason ?? ''}`.trim(),
    };
  },
};

const TRANSPORTS: Record<Platform, Transport> = {
  ios: apnsTransport,
  web: webPushTransport,
  bark: barkTransport,
};

/** The transport for a device row, or null if its platform column is unknown. */
export function transportFor(platform: string): Transport | null {
  return isPlatform(platform) ? TRANSPORTS[platform] : null;
}

/** Every transport that could send right now. */
export function configuredPlatforms(): Platform[] {
  return PLATFORMS.filter((p) => TRANSPORTS[p].isConfigured());
}

/**
 * Is push usable at all? Bark answers yes unconditionally, so in practice this is
 * only false if someone removes that transport — but `index.ts` still asks, so the
 * "no credentials anywhere" path stays a single early return rather than a
 * per-device no-op storm.
 */
export function anyTransportConfigured(): boolean {
  return configuredPlatforms().length > 0;
}
