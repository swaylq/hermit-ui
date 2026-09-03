'use client';

// Bridge to the native iOS shell (apps/ios). No-op in a normal browser.
//
// The shell is deliberately credential-free: it knows its APNs device token and
// nothing else. It hands that token here, and THIS side — which already holds the
// keyring and an authenticated fetch path — registers it once per machine. So a
// phone carrying three machine keys is subscribed to all three, and the native
// code never touches a secret.
//
// Two directions:
//   native → web   window.__hermitNative.onPushToken / .onDeepLink
//   web → native   window.webkit.messageHandlers.hermit.postMessage({type:'ready'})
//
// See docs/ios-shell-design.md.

import { getKeyring } from './keyring';

export type ApnsEnv = 'sandbox' | 'production';

/** What the OS says about notification permission, straight from the shell. */
export type NativePushStatus = {
  status: 'notDetermined' | 'denied' | 'authorized' | 'provisional' | 'ephemeral' | 'unknown';
  /** Has iOS actually handed the app an APNs token? False on the simulator. */
  registered: boolean;
};

interface NativeApi {
  onPushToken(token: string, apnsEnv: ApnsEnv): void;
  onDeepLink(path: string): void;
  onPushStatus(status: NativePushStatus['status'], registered: boolean): void;
}

declare global {
  interface Window {
    __hermitNative?: NativeApi;
    webkit?: { messageHandlers?: Record<string, { postMessage(msg: unknown): void }> };
  }
}

/** True when running inside the native shell rather than a browser / PWA. */
export function isNativeShell(): boolean {
  return typeof window !== 'undefined' && !!window.webkit?.messageHandlers?.hermit;
}

// Last status the shell reported, plus whoever is watching. Module-level so the
// Settings → Push card can mount after the answer arrived and still see it.
let pushStatus: NativePushStatus | null = null;
const pushWatchers = new Set<(s: NativePushStatus) => void>();

/** The shell's standing answer, or null if it hasn't said yet. */
export function getNativePushStatus(): NativePushStatus | null {
  return pushStatus;
}

/** Subscribe to status changes. Returns an unsubscribe. */
export function onNativePushStatus(fn: (s: NativePushStatus) => void): () => void {
  pushWatchers.add(fn);
  return () => pushWatchers.delete(fn);
}

/**
 * Tell the shell whether a live microphone stream exists right now.
 *
 * iOS needs the audio session in `.playAndRecord` or `getUserMedia` succeeds and
 * records pure silence, with no error anywhere. The shell used to switch it on
 * from the permission callback — which WebKit skips while it still holds a grant,
 * so "record → home → come back → record" captured nothing. Driving it from here
 * is exact: on while a stream is open, off the moment it is torn down, so nothing
 * else's audio gets ducked for the rest of the launch.
 */
export function setNativeMicActive(active: boolean): void {
  postToNative({ type: 'mic', active });
}

/** The taps the shell knows how to play. Mirrors apps/ios/Hermit/Haptics.swift. */
export type HapticStyle = 'prepare' | 'light' | 'medium' | 'selection' | 'success' | 'warning';

/**
 * Ask the shell for one haptic tap.
 *
 * There is no web fallback to fall back to. WebKit on iOS ships no
 * `navigator.vibrate` in any of its forms — not Safari, not an installed PWA,
 * not this shell — so outside the app every call here is a no-op and the
 * interaction is simply silent. That is also why the styles are named for what
 * they mean rather than for a waveform: the only implementation is UIKit's.
 *
 * Send `'prepare'` a beat before the tap that matters. The Taptic Engine spins
 * up on first use, so an unprepared tap arrives tens of milliseconds late, and
 * the tap that says "recording started" is worth nothing late.
 */
export function nativeHaptic(style: HapticStyle): void {
  postToNative({ type: 'haptic', style });
}

/**
 * Tell the shell whether its own back/forward edge swipe may run.
 *
 * WKWebView's swipe is a UIKit gesture recogniser sitting outside the web
 * content, so it takes the touch before any listener here sees it — a
 * `preventDefault()` in a `touchmove` handler cannot stop it. Any horizontal
 * gesture this app draws for itself has to be handed the edge explicitly, and
 * the only side that can do the handing is the native one.
 *
 * The shell defaults to off, so this is how the swipe gets turned back ON for
 * the layouts that have no gesture of their own (a wide iPad, where the sidebar
 * is static). Callers own a scope: turn it off while your gesture is armed, back
 * on when it unmounts.
 */
export function setNativeEdgeSwipe(enabled: boolean): void {
  postToNative({ type: 'edgeSwipe', enabled });
}

/** Ask the shell to read the permission answer. Never prompts. */
export function readNativePushStatus(): void {
  postToNative({ type: 'pushStatus' });
}

/**
 * Ask the OS for notification permission, now. iOS only ever shows the prompt
 * once per install, so the shell reports the standing answer when it has already
 * been asked — which is why the Settings card can point at iOS Settings instead
 * of leaving a button that looks broken.
 */
export function requestNativePush(): void {
  postToNative({ type: 'requestPush' });
}

function postToNative(msg: unknown): void {
  try {
    window.webkit?.messageHandlers?.hermit?.postMessage(msg);
  } catch {
    /* not in the shell, or the handler went away — nothing to do */
  }
}

/**
 * Register one device token against one machine key. Raw fetch rather than the
 * shared tRPC client because that client only ever carries the ACTIVE key and is
 * pinned to the ACTIVE backend, and we need to subscribe every machine in the
 * keyring — which may span deployments, hence the per-entry `base`.
 */
async function registerForKey(key: string, token: string, apnsEnv: ApnsEnv, base = ''): Promise<boolean> {
  const r = await fetch((base || '') + '/api/trpc/push.register?batch=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': key },
    body: JSON.stringify({ '0': { json: { token, apnsEnv, platform: 'ios' } } }),
  });
  return r.ok;
}

/**
 * Install the native-facing API on `window`. Safe to call in a browser (it just
 * leaves an object nothing will ever call). Returns a cleanup function.
 */
export function installNativeBridge(): () => void {
  if (typeof window === 'undefined') return () => {};

  const api: NativeApi = {
    onPushToken(token, apnsEnv) {
      // Scoped agent-share entries are skipped: push.register is machineProcedure
      // and would 403 them anyway, and a share link has no business subscribing a
      // device to a whole machine's notification stream.
      const machines = getKeyring().filter((e) => !e.scoped);
      void Promise.all(
        machines.map((e) =>
          registerForKey(e.key, token, apnsEnv, e.baseUrl || '').catch(() => false),
        ),
      ).then((results) => {
        postToNative({ type: 'registered', ok: results.filter(Boolean).length, of: machines.length });
        // A token arriving means iOS finished registering, which is a fact only
        // the shell can see (`isRegisteredForRemoteNotifications`). Ask again, or
        // Settings → Push sits on "authorized, but no APNs token yet" for the
        // whole session after a grant that actually worked.
        readNativePushStatus();
      });
    },

    onPushStatus(status, registered) {
      pushStatus = { status, registered };
      for (const fn of pushWatchers) fn(pushStatus);
    },

    onDeepLink(path) {
      if (!path.startsWith('/')) return; // only in-app paths, never an external URL
      // Hard navigation on purpose: with Next 16 behind the custom server, a
      // programmatic router.push to the same route with different query params
      // silently doesn't navigate (see auto-memory hermit-ui-router-nav-callback).
      window.location.href = path;
    },
  };

  // The shell also sets this at document start (WebViewController.swift) so the
  // FIRST paint already has the right insets. Setting it again here costs nothing
  // and means one lost user script does not silently switch the whole iOS layout
  // back off.
  if (isNativeShell()) document.documentElement.classList.add('native-shell');

  window.__hermitNative = api;
  // Tell the shell the page is live so it can replay a token or a tap that
  // arrived while the webview was still loading.
  postToNative({ type: 'ready' });

  // Which dashboards this device holds a key for. The shell holds no keyring, so
  // without this it treats a second deployment's uploads and links as off-site and
  // hands them to Safari — a different storage jar, and out of the app entirely.
  postToNative({
    type: 'origins',
    origins: getKeyring()
      .map((e) => e.baseUrl)
      .filter((b): b is string => !!b),
  });

  // Notification permission is asked for HERE, not at app launch. At launch there
  // is no machine key yet, so a granted token has nothing to register against and
  // a refusal is permanent — the prompt lands before the user knows what the app
  // is. With at least one key in the ring there is finally something to subscribe,
  // so ask; iOS shows the system prompt only the first time, and every later call
  // just reports the standing answer.
  if (getKeyring().some((e) => !e.scoped)) requestNativePush();
  else readNativePushStatus();

  return () => {
    if (window.__hermitNative === api) delete window.__hermitNative;
  };
}
