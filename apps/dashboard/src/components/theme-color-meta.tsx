'use client';

// Keep the installed-PWA window frame / title bar (e.g. on macOS) and the mobile
// browser UI tint matching the RESOLVED app theme. The static media-query
// theme-color metas (layout.tsx viewport) already follow the SYSTEM scheme and
// cover first paint; this pushes the resolved theme live so an explicit
// Appearance override (pinned light/dark) is honoured too, and it updates the
// frame instantly when the system scheme or the override changes.

import { useEffect } from 'react';
import { useTheme } from 'next-themes';

export function ThemeColorMeta() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (!resolvedTheme) return;
    const color = resolvedTheme === 'dark' ? '#09090b' : '#ffffff';
    // Own a single non-media theme-color meta (appended last, so it wins over the
    // static media-query ones for the actual frame color).
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = color;
  }, [resolvedTheme]);
  return null;
}
