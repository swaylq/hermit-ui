// asst dashboard — service worker.
//
// Two jobs:
//   1. Installability (Chrome/Edge need a registered SW + fetch handler) + a
//      clean offline fallback page.
//   2. Cache-first for Next's immutable, content-hashed build assets
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

const VERSION = 'v2';
const SHELL_CACHE = `asst-shell-${VERSION}`;
const ASSET_CACHE = `asst-assets-${VERSION}`;
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
  const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
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

  // Everything else (/api/*, /api/trpc, /uploads, dynamic routes) → straight to
  // the network, untouched. No respondWith ⇒ no stale dashboard data, ever.
});
