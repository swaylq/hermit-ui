// asst dashboard — service worker.
//
// Three jobs:
//   1. Installability (Chrome/Edge need a registered SW + fetch handler) + a
//      clean offline fallback page.
//   2. Web Push: rendering notifications and routing taps back into the app.
//      This is what lets an iPhone receive pushes with no native app at all —
//      see docs/no-app-push-design.md and src/server/push/webpush.ts.
//   3. Cache-first for Next's immutable, content-hashed build assets
//      (`/_next/static/*` — JS chunks, CSS, next/font files). An installed PWA
//      then cold-starts by reading ~2 MB of JS/CSS from the Cache Storage
//      instead of re-downloading it over the network every single launch — the
//      single biggest win for cold-start time in standalone mode.
//
// We still NEVER cache navigations or API / tRPC responses — those stay
// network-first / untouched, so dashboard DATA is never stale. Safety rests on
// one fact: a content hash in the `/_next/static/` path means the bytes for a
// given URL never change, so a cached hit is always correct. A new deploy ships
// NEW hashes (new URLs → cache miss → fetched fresh); the VERSION bump below
// evicts the previous build's assets on activate.

const VERSION = 'v3';
const SHELL_CACHE = `asst-shell-${VERSION}`;
const ASSET_CACHE = `asst-assets-${VERSION}`;
// Chat image thumbnails. Separate cache so its own budget can be enforced
// without touching the build assets, and NOT version-suffixed: the bytes at a
// uuid url never change, so there is nothing for a deploy to invalidate and no
// reason to make an installed phone re-download them.
const IMAGE_CACHE = 'asst-thumbs';
// ~400 x ~16KB ≈ 6MB. iOS evicts a whole origin's storage when it feels like
// it, so this is a courtesy bound, not a guarantee.
const IMAGE_CACHE_MAX = 400;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Keep only the current version's caches; drop everything older (incl. the
  // previous build's hashed assets and the old asst-shell-v1).
  const keep = new Set([SHELL_CACHE, ASSET_CACHE, IMAGE_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch tRPC mutations / uploads
  const url = new URL(req.url);

  // Top-level navigations: network-first → offline fallback. Never cached, so the
  // HTML — and the hashed asset URLs it references — is always the latest deploy.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(OFFLINE_URL).then((r) => r || new Response('offline', { status: 503 })),
      ),
    );
    return;
  }

  // Immutable, content-hashed build assets → cache-first (instant cold-start).
  // Same-origin `/_next/static/` only: the hash in the path guarantees the bytes
  // never change for this URL, so a hit is always correct and skips the network.
  if (url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(ASSET_CACHE).then((cache) =>
        cache.match(req).then((hit) => {
          if (hit) return hit;
          return fetch(req).then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          });
        }),
      ),
    );
    return;
  }

  // Chat image thumbnails → cache-first, on the same argument as the hashed
  // assets above: the path carries a uuid, so the bytes for a given url never
  // change and a hit is always correct. Without this an installed PWA refetches
  // every picture in a conversation whenever iOS drops the HTTP cache, which it
  // does aggressively. Only `.thumb.webp` — the full-size `.safe.` file is what
  // the lightbox opens, and 535KB a piece has no business in a phone's cache.
  if (url.origin === self.location.origin && url.pathname.startsWith('/uploads/') && url.pathname.endsWith('.thumb.webp')) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then((cache) =>
        cache.match(req).then((hit) => {
          if (hit) return hit;
          return fetch(req).then((res) => {
            if (res.ok) {
              cache.put(req, res.clone()).then(() => trimImageCache(cache));
            }
            return res;
          });
        }),
      ),
    );
    return;
  }

  // Everything else (/api/*, /api/trpc, /uploads/*.safe.*, dynamic routes) →
  // straight to the network, untouched. No respondWith ⇒ no stale data, ever.
});

// Cache Storage hands back keys in insertion order, so the front of the list is
// the least recently ADDED. Dropping a batch rather than one at a time keeps
// this off the hot path — it runs once per ~40 new thumbnails, not once per
// picture.
function trimImageCache(cache) {
  return cache.keys().then((keys) => {
    if (keys.length <= IMAGE_CACHE_MAX) return;
    const excess = keys.length - IMAGE_CACHE_MAX + Math.floor(IMAGE_CACHE_MAX / 10);
    return Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
  });
}

// ── Web Push ────────────────────────────────────────────────────────────────
// The server sends ONE payload shape (src/server/push/webpush.ts): Declarative
// Web Push, i.e. `{ web_push: 8030, notification: {...} }`.
//
// On iOS 18.4+ the browser renders that notification itself, without running any
// of this — which is both the reliable path and the fallback when a service
// worker fails to start. Everywhere else (older iOS, Chrome, Firefox) the same
// object arrives here instead and this handler draws it. One payload, no
// user-agent branching.
//
// Where both happen, they collapse rather than double up: `tag` is the server's
// collapseKey on both paths, and a second notification with an existing tag
// REPLACES it. That is the same one-slot-per-session guarantee APNs gets from
// apns-collapse-id.

const FALLBACK_NOTIFICATION = {
  title: 'Hermit',
  body: 'You have a new notification',
};

function parsePush(event) {
  if (!event.data) return FALLBACK_NOTIFICATION;
  try {
    const raw = event.data.json();
    // Declarative shape; also tolerate a bare notification object.
    const n = raw && typeof raw === 'object' ? raw.notification || raw : null;
    if (!n || typeof n.title !== 'string') return FALLBACK_NOTIFICATION;
    return n;
  } catch {
    // Not JSON — show whatever text arrived rather than dropping the push.
    const text = event.data.text();
    return text ? { title: 'Hermit', body: text } : FALLBACK_NOTIFICATION;
  }
}

self.addEventListener('push', (event) => {
  const n = parsePush(event);
  // `navigate` is the declarative field (absolute URL); `data.path` is the
  // in-app path. Keep both — the click handler prefers the path.
  const data = { path: (n.data && n.data.path) || pathFromUrl(n.navigate) || '/' };
  event.waitUntil(
    self.registration.showNotification(n.title, {
      body: n.body || '',
      tag: n.tag || undefined,
      // Replace silently: a re-sent turn shouldn't buzz twice for one session.
      renotify: false,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data,
    }),
  );
});

function pathFromUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url, self.location.origin);
    // Never navigate off our own origin on the strength of a push payload.
    return u.origin === self.location.origin ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Reuse an open window when there is one. In an installed iOS PWA there is
      // only ever one, and launching a second is not even possible — so focus it
      // and navigate, rather than no-op'ing on a window that shows the wrong page.
      for (const c of clients) {
        if (new URL(c.url).origin !== self.location.origin) continue;
        return c.focus().then((focused) => {
          const target = (focused || c);
          return target.navigate ? target.navigate(path).catch(() => undefined) : undefined;
        });
      }
      return self.clients.openWindow(path);
    }),
  );
});
