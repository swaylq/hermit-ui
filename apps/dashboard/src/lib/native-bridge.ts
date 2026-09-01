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

interface NativeApi {
  onPushToken(token: string, apnsEnv: ApnsEnv): void;
  onDeepLink(path: string): void;
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
      });
    },

    onDeepLink(path) {
      if (!path.startsWith('/')) return; // only in-app paths, never an external URL
      // Hard navigation on purpose: with Next 16 behind the custom server, a
      // programmatic router.push to the same route with different query params
      // silently doesn't navigate (see auto-memory hermit-ui-router-nav-callback).
      window.location.href = path;
    },
  };

  window.__hermitNative = api;
  // Tell the shell the page is live so it can replay a token or a tap that
  // arrived while the webview was still loading.
  postToNative({ type: 'ready' });

  return () => {
    if (window.__hermitNative === api) delete window.__hermitNative;
  };
}
