'use client';

import { useState, useEffect } from 'react';
import { ThemeProvider } from 'next-themes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, loggerLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '@/lib/trpc';
import { getActiveKey } from '@/lib/keyring';

// Key storage moved to lib/keyring (multi-machine browser keyring). Re-export
// the active-key getter so any importer of `@/app/providers` keeps working.
export { getActiveKey } from '@/lib/keyring';

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 4000, refetchOnWindowFocus: false },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        loggerLink({ enabled: () => false }),
        httpBatchLink({
          url: '/api/trpc',
          transformer: superjson,
          headers() {
            return { 'x-asst-key': getActiveKey() };
          },
        }),
      ],
    }),
  );

  // iOS Safari ignores `user-scalable=no` / `maximum-scale` in the viewport
  // meta, so block its pinch-zoom gestures directly. (Android & WKWebView honour
  // the meta; on them these `gesture*` events never fire, so this is a no-op.)
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', block, { passive: false });
    document.addEventListener('gesturechange', block, { passive: false });
    document.addEventListener('gestureend', block, { passive: false });
    return () => {
      document.removeEventListener('gesturestart', block);
      document.removeEventListener('gesturechange', block);
      document.removeEventListener('gestureend', block);
    };
  }, []);

  // In an installed iOS PWA, 100dvh is unreliable (cold-start / phantom-toolbar
  // bugs leave a white gap at the bottom). Mirror the REAL rendered height into
  // --app-h so the app shell (.app-h) fills the screen exactly. visualViewport
  // .height also tracks the on-screen keyboard, keeping the composer above it.
  // In a normal browser tab .app-h uses 100dvh instead, so this just feeds a var
  // nothing consumes there.
  useEffect(() => {
    const vv = window.visualViewport;
    const setVar = (h: number) => document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
    // Live height — tracks the keyboard (visualViewport shrinks when it opens, so
    // the shell shrinks and the composer stays above it).
    const measure = () => setVar(vv?.height ?? window.innerHeight);
    measure();
    window.addEventListener('resize', measure);
    vv?.addEventListener('resize', measure);

    // iOS bug: after the on-screen keyboard DISMISSES, visualViewport height /
    // offsetTop don't fully revert and the window is often left scrolled — so the
    // shell stays short and a white gap reappears at the bottom. On blur, reset
    // the scroll and re-measure the full height (window.innerHeight ignores the
    // keyboard) once the dismiss animation settles. Two passes catch fast + slow.
    const onBlur = () => {
      const fix = () => {
        window.scrollTo(0, 0);
        setVar(window.innerHeight);
      };
      setTimeout(fix, 100);
      setTimeout(fix, 400);
    };
    window.addEventListener('focusout', onBlur);

    return () => {
      window.removeEventListener('resize', measure);
      vv?.removeEventListener('resize', measure);
      window.removeEventListener('focusout', onBlur);
    };
  }, []);

  return (
    // Theme: follows the OS by default; the Settings → Appearance tab can pin
    // light/dark. next-themes toggles the `.dark` class on <html> (no flash).
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    </ThemeProvider>
  );
}
