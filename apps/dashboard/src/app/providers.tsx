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

    // Fill the TRUE screen. In an installed iOS PWA the layout viewport
    // (innerHeight / documentElement.clientHeight) is ~62px shorter than the real
    // screen — it excludes the top safe area — and innerHeight even flip-flops
    // between the short and full value. window.screen.height is the STABLE full
    // canvas, so size the shell to that (the root scroll is locked in CSS so a
    // shell taller than the layout viewport doesn't make the page scroll). While
    // the keyboard is open (visible height well below the screen) shrink to the
    // visible area so the composer stays above it.
    const measure = () => {
      const ih = window.innerHeight;
      const sh = window.screen?.height || ih;
      const vh = vv?.height ?? ih;
      const keyboardOpen = vh < sh - 120;
      setVar(keyboardOpen ? vh : sh);
    };
    measure();
    window.addEventListener('resize', measure);
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);

    // iOS: after the keyboard dismisses, things don't fully revert and the window
    // is often left scrolled — reset scroll + re-measure once the dismiss
    // animation settles (two passes catch fast + slow).
    const onBlur = () => {
      const fix = () => { window.scrollTo(0, 0); measure(); };
      setTimeout(fix, 100);
      setTimeout(fix, 400);
    };
    window.addEventListener('focusout', onBlur);

    return () => {
      window.removeEventListener('resize', measure);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
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
