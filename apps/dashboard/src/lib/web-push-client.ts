'use client';

// Browser side of Web Push — subscribe the installed PWA, hand the subscription
// to every machine in the keyring, tear it back down.
//
// Mirrors lib/native-bridge.ts on purpose, for the same reason: the keyring lives
// here, so THIS side registers once per machine key and a phone carrying three
// keys receives pushes from all three. The difference is only where the device
// identity comes from — the native shell is handed an APNs token, here the browser
// mints a PushSubscription.
//
// iOS constraints this has to respect (docs/no-app-push-design.md):
//   · Push works ONLY from a Home Screen web app. In a Safari tab `PushManager`
//     is absent, so `pushSupport()` reports why rather than failing at subscribe.
//   · `Notification.requestPermission()` must be reached from a real user gesture,
//     hence subscribe() being called straight out of an onClick and never from an
//     effect.

import { getKeyring } from './keyring';
import { isNativeShell } from './native-bridge';

export type PushSupport =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'needs-install' | 'no-vapid-key' | 'native-shell' };

/** Is the page running as an installed app rather than a browser tab? */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Can this browser subscribe right now, and if not, which of the two very
 * different "no" answers is it? `needs-install` is actionable by the user (Share →
 * Add to Home Screen); `unsupported` is not.
 */
export function pushSupport(vapidPublicKey: string | null): PushSupport {
  if (typeof window === 'undefined') return { ok: false, reason: 'unsupported' };
  // The native shell has no Push API at all and does not need one — it is
  // already registered for APNs. Checked before the VAPID key so the page never
  // tells someone standing inside the app to go install the app.
  if (isNativeShell()) return { ok: false, reason: 'native-shell' };
  if (!vapidPublicKey) return { ok: false, reason: 'no-vapid-key' };
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (!('PushManager' in window)) {
    // iOS Safari exposes PushManager only to Home Screen web apps, so on an
    // iPhone this is "not installed yet" rather than "never going to work".
    return { ok: false, reason: isIos() && !isStandalone() ? 'needs-install' : 'unsupported' };
  }
  return { ok: true };
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

/** Current permission, without prompting. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/**
 * VAPID keys travel as base64url; `applicationServerKey` wants the raw 65 bytes.
 * Safari has historically rejected the string form, so always convert.
 */
function decodeBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  // Explicit ArrayBuffer backing: `applicationServerKey` wants a BufferSource over
  // a plain ArrayBuffer, and the default Uint8Array type admits SharedArrayBuffer.
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Register one subscription against one machine key. Raw fetch rather than the
 * shared tRPC client because that client only ever carries the ACTIVE key and is
 * pinned to the ACTIVE backend, and we need to subscribe every machine in the
 * keyring — which may span deployments, hence the per-entry `base`.
 *
 * A subscription is minted against ONE VAPID public key, so deployments that
 * share a browser must share their VAPID keypair; otherwise the far one stores
 * the row happily and every send is rejected by the push service. See
 * `.env.example` (VAPID_PUBLIC_KEY).
 */
async function registerForKey(key: string, subscription: PushSubscriptionJSON, base = ''): Promise<boolean> {
  const r = await fetch((base || '') + '/api/trpc/push.registerWeb?batch=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': key },
    body: JSON.stringify({ '0': { json: { subscription } } }),
  });
  return r.ok;
}

async function unregisterForKey(key: string, token: string, base = ''): Promise<boolean> {
  const r = await fetch((base || '') + '/api/trpc/push.unregister?batch=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': key },
    body: JSON.stringify({ '0': { json: { token } } }),
  });
  return r.ok;
}

/**
 * Machines this browser may subscribe. Scoped agent-share entries are skipped:
 * push.registerWeb is a machineProcedure and would 403 them anyway, and a share
 * link has no business subscribing a device to a whole machine's stream.
 */
function subscribableMachines() {
  return getKeyring().filter((e) => !e.scoped);
}

export interface SubscribeResult {
  ok: boolean;
  /** How many keyring machines now push to this device. */
  registered: number;
  of: number;
  reason?: 'denied' | 'no-machines' | 'failed';
}

/**
 * Ask for permission (if needed), subscribe, and register with every machine.
 * MUST be called from a user gesture — see the header.
 */
export async function subscribeWebPush(vapidPublicKey: string): Promise<SubscribeResult> {
  const machines = subscribableMachines();
  if (machines.length === 0) return { ok: false, registered: 0, of: 0, reason: 'no-machines' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, registered: 0, of: machines.length, reason: 'denied' };
  }

  const reg = await navigator.serviceWorker.ready;
  // Reuse an existing subscription when there is one: re-subscribing would mint a
  // new endpoint and leave the old row to be reaped the slow way, on its next 410.
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      // Non-negotiable on every browser that ships Push: no silent pushes.
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(vapidPublicKey),
    }));

  const json = sub.toJSON();
  const results = await Promise.all(
    machines.map((e) => registerForKey(e.key, json, e.baseUrl || '').catch(() => false)),
  );
  const registered = results.filter(Boolean).length;
  return {
    ok: registered > 0,
    registered,
    of: machines.length,
    reason: registered > 0 ? undefined : 'failed',
  };
}

/**
 * Drop the subscription and every server-side row pointing at it.
 *
 * Order matters: unregister first, then tell the browser. If the browser call
 * fails afterwards the rows are already gone, so the worst case is a dead local
 * subscription. Doing it the other way round can strand rows whose endpoint no
 * longer exists, and those only clear on their next failed send.
 */
export async function unsubscribeWebPush(): Promise<{ ok: boolean }> {
  if (!('serviceWorker' in navigator)) return { ok: false };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { ok: true };

  await Promise.all(
    subscribableMachines().map((e) => unregisterForKey(e.key, sub.endpoint, e.baseUrl || '').catch(() => false)),
  );
  await sub.unsubscribe().catch(() => false);
  return { ok: true };
}

/** The endpoint this browser is currently subscribed with, if any. */
export async function currentEndpoint(): Promise<string | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (!('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}
