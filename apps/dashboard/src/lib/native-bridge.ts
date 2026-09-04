'use client';

// Bridge to the native iOS shell (apps/ios). No-op in a normal browser.
//
// The shell authenticates nothing: it knows its APNs device token, and it hands
// that token here, to the side that has the keyring and an authenticated fetch
// path. THIS side registers it once per machine, so a phone carrying three machine
// keys is subscribed to all three. Native code never sends a request of its own.
//
// It does hold the keyring, as of M1: `keychain.get`/`.set`/`.clear` over
// `nativeRequest` below, called only from lib/keyring.ts. The shell keeps one
// opaque string per origin in the device Keychain and never parses it — the web
// layer remains the only thing that knows what a machine key is.
//
// Two directions:
//   native → web   window.__hermitNative.onPushToken / .onDeepLink
//   web → native   window.webkit.messageHandlers.hermit.postMessage({type:'ready'})
//
// …and two shapes. Everything above is a one-way announcement; `nativeRequest`
// and `onNativeRequest` below are the other shape, a question paired with its
// answer by an id.
//
// See docs/ios-shell-design.md.

import { getKeyring, getActiveEntry } from './keyring';

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
  onLiveActivityStatus(supported: boolean, enabled: boolean): void;
  onLiveActivityToken(kind: 'update' | 'start', token: string, sessionId: string, sinceMs: number): void;
  /** The shell answering a `nativeRequest`. */
  onReply(id: string, ok: boolean, payload: unknown): void;
  /** The shell asking THIS side something; answered by `onNativeRequest`. */
  onRequest(id: string, method: string, params: Record<string, unknown>): void;
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
/**
 * Which APNs host this build's tokens belong to, as the shell read it out of the
 * embedded provisioning profile. An Xcode install and a TestFlight one produce
 * tokens that look identical and are accepted by different hosts, so the server
 * cannot infer it — and a Live Activity token belongs to the same host as the
 * device token that arrived beside it.
 *
 * Defaults to sandbox because that is what a build installed for development
 * gets, and because the server retries the other host on `BadDeviceToken` and
 * writes back what worked — a wrong guess here costs one round trip, once.
 */
let lastApnsEnv: ApnsEnv = 'sandbox';
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

// ── Live Activity (Lock Screen + Dynamic Island) ────────────────────────────
//
// The shell raises it, the SERVER keeps it moving. That split is the whole
// point: an activity only its own app can update freezes the moment the phone
// is put down, which is the only time a lock-screen widget matters. So the app
// starts one with a push token, hands the token here, and this side registers it
// with the machine key — the same arrangement as the APNs device token, and for
// the same reason: the native layer never authenticates anything itself.
//
// What this side owes the shell is the lifecycle, because only the page knows
// when a turn began. See components/chat/use-live-activity.ts.

export type LiveActivityPhase = 'working' | 'blocked' | 'done' | 'failed';

export interface LiveActivityState {
  phase: LiveActivityPhase;
  /** The session's title. */
  title: string;
  /** The one line worth reading: what it is doing, what it is asking, or what
   *  it said. Truncated by the shell to fit the APNs payload cap. */
  line: string;
  /** When THIS phase began, in JS milliseconds. The widget renders it as a
   *  system timer, which is the only part that stays live without a push. */
  sinceMs: number;
  /** Messages waiting behind the running one. */
  queued?: number;
  /** How full the context window is, 0-100, rounded. Undefined before the first
   *  completed turn — the widget shows `ctx —` rather than hiding the row, the
   *  same rule the web bar follows. Rounded because the raw token count moves
   *  every few seconds and every move would be a push. */
  ctxPct?: number;
}

/** Raise one for a session. A second call for a session that already has one
 *  updates it instead — the shell will not stack duplicates. */
export function liveActivityStart(a: {
  sessionId: string;
  agentName: string;
  machineName?: string;
  state: LiveActivityState;
}): void {
  postToNative({ type: 'liveActivity', action: 'start', ...a });
}

export function liveActivityUpdate(sessionId: string, state: LiveActivityState): void {
  postToNative({ type: 'liveActivity', action: 'update', sessionId, state });
}

/** End it. The shell leaves it on screen a few minutes so a finished turn can
 *  still be noticed, then clears it. */
export function liveActivityEnd(sessionId: string, state?: LiveActivityState): void {
  postToNative({ type: 'liveActivity', action: 'end', sessionId, state });
}

/** Every activity, gone now. For a sign-out or a workspace switch: what is on
 *  that Lock Screen belongs to a machine this device no longer answers for. */
export function liveActivityEndAll(): void {
  postToNative({ type: 'liveActivity', action: 'endAll' });
}

type LiveActivitySupport = { supported: boolean; enabled: boolean };
let liveActivitySupport: LiveActivitySupport | null = null;
const liveActivityWatchers = new Set<(s: LiveActivitySupport) => void>();

/** What the shell last said. Null before it has answered, and outside the shell
 *  forever — callers treat both as "do not send". */
export function getLiveActivitySupport(): LiveActivitySupport | null {
  return liveActivitySupport;
}

export function onLiveActivitySupport(fn: (s: LiveActivitySupport) => void): () => void {
  liveActivityWatchers.add(fn);
  return () => liveActivityWatchers.delete(fn);
}

/** Ask. Cheap, never prompts — Live Activities have no permission dialog, only
 *  a switch in Settings the user may have turned off. */
export function requestLiveActivitySupport(): void {
  postToNative({ type: 'liveActivityStatus' });
}

/**
 * Register an activity's push token so the server can address updates to it.
 *
 * Uses the ACTIVE keyring entry only, unlike the device token which is
 * registered against every machine: a device token addresses a phone, but an
 * activity token addresses one running turn, which belongs to exactly one
 * machine. Registering it anywhere else would let another deployment write to a
 * Lock Screen showing this one's session.
 */
async function registerLiveActivityToken(
  kind: 'update' | 'start',
  token: string,
  sessionId: string,
  sinceMs: number,
): Promise<void> {
  const entry = getActiveEntry();
  if (!entry || entry.scoped) return; // a share link has no business doing this
  const input =
    kind === 'update'
      ? { json: { kind, token, sessionId, apnsEnv: lastApnsEnv, sinceMs: sinceMs || undefined } }
      : { json: { kind, token, apnsEnv: lastApnsEnv } };
  await fetch((entry.baseUrl || '') + '/api/trpc/push.registerLiveActivity?batch=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': entry.key },
    body: JSON.stringify({ '0': input }),
  }).catch(() => undefined);
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

// ── The question channel ────────────────────────────────────────────────
//
// Everything above is an announcement: it is sent and forgotten. A question is
// the other shape — it expects an answer, in either direction, matched to its
// request by an id the asker invents and the answerer echoes back untouched.
//
//   web → native   postMessage({ type:'req',   id, method, params })
//                  window.__hermitNative.onReply(id, ok, payload)
//   native → web   window.__hermitNative.onRequest(id, method, params)
//                  postMessage({ type:'reply', id, ok, payload })
//
// The ASKER owns the timeout, so neither side can be left holding a promise (or
// a completion block) that never settles. Callers so far: lib/keyring.ts
// (`keychain.get`/`.set`/`.clear`) and the server switcher (`getOrigin`/
// `setOrigin`). The outbox for offline sends is the next one.
// See apps/ios/Hermit/NativeBridge.swift.

/** Both halves give up on an answer after this. Mirrored in NativeBridge.swift
 *  (`replyTimeout`). */
const REPLY_TIMEOUT_MS = 5000;

type Pending = {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pendingReplies = new Map<string, Pending>();
let requestSeq = 0;

/** The shell's own words when it refuses, or a generic line if it sent none. */
function replyError(method: string, payload: unknown): Error {
  const said = (payload as { error?: unknown } | null | undefined)?.error;
  return new Error(typeof said === 'string' && said ? said : `native ${method} failed`);
}

/**
 * Ask the shell something, and wait for its answer.
 *
 * Rejects rather than hangs in all four ways this can go wrong: outside the
 * shell, when the shell has never heard of the method, when the shell answers
 * with a failure, and after five seconds of silence. Callers need a web-side
 * fallback for the first of those regardless — this same code runs in a browser.
 */
export function nativeRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!isNativeShell()) {
      reject(new Error('not running in the native shell'));
      return;
    }
    // Unique within this document, which is all it needs to be: the shell drops
    // everything it was waiting on the moment the page navigates.
    const id = `w${++requestSeq}`;
    const timer = setTimeout(() => {
      pendingReplies.delete(id);
      reject(new Error(`native ${method} timed out`));
    }, REPLY_TIMEOUT_MS);
    pendingReplies.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
    if (!postToNative({ type: 'req', id, method, params })) {
      clearTimeout(timer);
      pendingReplies.delete(id);
      reject(new Error('not running in the native shell'));
    }
  });
}

type NativeRequestHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;
const requestHandlers = new Map<string, NativeRequestHandler>();

/**
 * Answer `method` when the SHELL asks. Returns an unregister.
 *
 * One handler per method, last registration wins: two components claiming the
 * same method is a bug, and silently leaving the second one unreachable would
 * hide it.
 */
export function onNativeRequest(method: string, fn: NativeRequestHandler): () => void {
  requestHandlers.set(method, fn);
  return () => {
    if (requestHandlers.get(method) === fn) requestHandlers.delete(method);
  };
}

/** True when the message went to the shell; false in a browser, or if the
 *  handler has gone away underneath us. */
function postToNative(msg: unknown): boolean {
  try {
    const handler = window.webkit?.messageHandlers?.hermit;
    if (!handler) return false;
    handler.postMessage(msg);
    return true;
  } catch {
    /* not in the shell, or the handler went away — nothing to do */
    return false;
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
      lastApnsEnv = apnsEnv;
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

    onLiveActivityStatus(supported, enabled) {
      liveActivitySupport = { supported, enabled };
      for (const fn of liveActivityWatchers) fn(liveActivitySupport);
    },

    onLiveActivityToken(kind, token, sessionId, sinceMs) {
      void registerLiveActivityToken(kind, token, sessionId, sinceMs);
    },

    onReply(id, ok, payload) {
      const p = pendingReplies.get(id);
      // No entry means it already timed out (its caller has moved on), or an id
      // this document never issued. Either way there is nothing to settle.
      if (!p) return;
      pendingReplies.delete(id);
      clearTimeout(p.timer);
      if (ok) p.resolve(payload);
      else p.reject(replyError(p.method, payload));
    },

    onRequest(id, method, params) {
      const fn = requestHandlers.get(method);
      if (!fn) {
        // Answered, not ignored: the shell is holding a completion block, and
        // silence would cost it the full five seconds for a question that can
        // never be answered by this build.
        postToNative({ type: 'reply', id, ok: false, payload: { error: `unknown method: ${method}` } });
        return;
      }
      void (async () => {
        try {
          const payload = await fn(params ?? {});
          postToNative({ type: 'reply', id, ok: true, payload: payload ?? null });
        } catch (e) {
          postToNative({
            type: 'reply',
            id,
            ok: false,
            payload: { error: String((e as Error)?.message ?? e) },
          });
        }
      })();
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

  // Which dashboards this device holds a key for. The shell cannot read the
  // keyring (it stores one opaque blob per origin and never parses it), so without
  // this it treats a second deployment's uploads and links as off-site and hands
  // them to Safari — a different storage jar, and out of the app entirely.
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

  // No prompt behind this one — Live Activities are a Settings switch, not a
  // permission — so it is asked unconditionally and answered immediately.
  requestLiveActivitySupport();

  return () => {
    if (window.__hermitNative === api) delete window.__hermitNative;
    // A question asked through a bridge that is being torn down has no route
    // left for its answer, so settle it here rather than let it time out.
    const inflight = [...pendingReplies.values()];
    pendingReplies.clear();
    for (const p of inflight) {
      clearTimeout(p.timer);
      p.reject(new Error(`native ${p.method} was cancelled`));
    }
  };
}
