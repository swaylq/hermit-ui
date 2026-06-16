// asst dashboard — minimal service worker.
//
// Purpose: make the app installable (Chrome/Edge require a registered SW with a
// fetch handler) and show a clean offline page. We deliberately do NOT cache
// dynamic dashboard data — navigations are network-first so content is always
// fresh; only a tiny offline fallback + the app icon are precached. skipWaiting +
// clients.claim means a new deploy's SW takes over immediately.

const CACHE = 'asst-shell-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only intercept top-level navigations: try the network, fall back to the
  // cached offline page when truly offline. Everything else hits the network
  // untouched (no respondWith) — no stale dashboard data, ever.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(OFFLINE_URL).then((r) => r || new Response('offline', { status: 503 })),
      ),
    );
  }
});
