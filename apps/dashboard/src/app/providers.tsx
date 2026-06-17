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
    const setAppH = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
    };
    setAppH();
    window.addEventListener('resize', setAppH);
    window.visualViewport?.addEventListener('resize', setAppH);
    return () => {
      window.removeEventListener('resize', setAppH);
      window.visualViewport?.removeEventListener('resize', setAppH);
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
