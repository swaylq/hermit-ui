import type { MetadataRoute } from 'next';

// Web app manifest (served at /manifest.webmanifest, link auto-injected by Next).
// Makes dash.swaylab.ai installable as a standalone desktop/mobile app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'asst dashboard',
    short_name: 'asst',
    description: 'hermit-agent state, sessions, and tasks',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#09090b',
    theme_color: '#09090b',
    orientation: 'any',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
