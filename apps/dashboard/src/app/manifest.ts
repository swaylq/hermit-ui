import type { MetadataRoute } from 'next';

// Web app manifest (served at /manifest.webmanifest, link auto-injected by Next).
// Makes dash.swaylab.ai installable as a standalone desktop/mobile app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Hermit',
    short_name: 'Hermit',
    description: 'hermit-agent state, sessions, and tasks',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#09090b',
    theme_color: '#09090b',
    orientation: 'any',
    // ?v=N is a cache-buster: Chrome caches an installed PWA's icon and only
    // re-downloads when the icon URL changes. Bump N whenever the icon art changes.
    icons: [
      { src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
