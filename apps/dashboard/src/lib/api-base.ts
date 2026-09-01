'use client';

// Where this tab's requests go.
//
// A keyring entry used to mean "a machine on THIS dashboard". It can now also
// carry a `baseUrl` — the origin of a DIFFERENT dashboard deployment — so one
// installed PWA (which is bound to exactly one origin, e.g. dash.swaylab.ai)
// can drive several deployments. `baseUrl` empty/absent = this origin, which is
// what every pre-existing entry means, so nothing changes for a single-instance
// user.
//
// Why this is safe to read once per page load: switching entries already does a
// full reload (`workspace-switcher.tsx` → `window.location.href`), so the active
// backend cannot change under a live tRPC client, SSE reader or WebSocket.
//
// The credential travels as the `x-asst-key` REQUEST HEADER, never a cookie, so
// pointing at another origin needs no session/SameSite work — only CORS on the
// far end (`CORS_ALLOW_ORIGINS` there must list this origin).

import { getActiveEntry, getKeyring, setActiveMachine } from '@/lib/keyring';
import { machineIdFromSearch } from '@/lib/machine-param';

/**
 * Normalize a user-typed backend address into `https://host[:port]`, or '' for
 * "this origin". Throws on anything that isn't a plain http(s) origin — a typo
 * that silently became a relative path would send the key to the wrong server.
 */
export function normalizeBase(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error('backend address is not a URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('backend address must be http(s)');
  if (u.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)) {
    throw new Error('backend address must be https (http is only allowed for localhost)');
  }
  if (u.pathname !== '/' || u.search || u.hash) throw new Error('backend address must be a bare origin, no path');
  return u.origin;
}

/** '' when the active entry lives on this origin, else `https://host`. */
export function apiBase(): string {
  if (typeof window === 'undefined') return '';
  const base = getActiveEntry()?.baseUrl || '';
  // A stored base equal to our own origin is the same thing as '' — collapse it
  // so the common case never pays a CORS preflight.
  return base && base !== window.location.origin ? base : '';
}

/** True when this tab is driving another deployment (used for UI hints). */
export function isRemoteBase(): boolean {
  return apiBase() !== '';
}

/**
 * Absolute-path (`/api/...`) → the active backend. Anything already absolute
 * (`https://…`, `data:`, `blob:`) is returned untouched, so call sites can pass
 * URLs of unknown provenance.
 */
export function apiUrl(path: string, base: string = apiBase()): string {
  if (!base) return path;
  if (!path.startsWith('/')) return path;
  return base + path;
}

/** Same as `apiUrl`, for `/uploads/...` images, video, audio and attachments. */
export function mediaUrl(url: string): string {
  return url.startsWith('/uploads/') ? apiUrl(url) : url;
}

/** `ws(s)://host/api/term/...` on the active backend. */
export function wsUrl(path: string): string {
  const base = apiBase();
  const origin = base || (typeof window === 'undefined' ? '' : window.location.origin);
  return origin.replace(/^http/, 'ws') + path;
}

/**
 * Host of an entry's deployment, or '' when it lives on this origin. Shown in
 * the switcher so "mac-local" on two different dashboards can be told apart —
 * and so you can see which one you are about to type into.
 */
export function baseHost(baseUrl: string | null | undefined): string {
  if (!baseUrl) return '';
  try {
    const h = new URL(baseUrl).host;
    return typeof window !== 'undefined' && h === window.location.host ? '' : h;
  } catch {
    return '';
  }
}

/**
 * Honour the `?m=<machineId>` a notification tap-through carries: select that
 * workspace before anything reads `apiBase()`.
 *
 * Called synchronously from the Providers initializer, so the tRPC client, the
 * SSE reader and every WebSocket are built against the RIGHT deployment on the
 * first paint — no reload, no flash of the wrong machine's sessions. Unknown
 * ids are ignored: a push from a machine this browser no longer holds a key for
 * should land you where you were, not on a broken switch.
 */
export function adoptMachineFromUrl(): void {
  if (typeof window === 'undefined') return;
  const id = machineIdFromSearch(window.location.search);
  if (!id) return;
  const active = getActiveEntry();
  if (active?.id === id) return;
  if (!getKeyring().some((e) => e.id === id)) return;
  setActiveMachine(id);
}
