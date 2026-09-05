'use client';

import { useState, useEffect } from 'react';
import { ThemeProvider } from 'next-themes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, httpLink, loggerLink, splitLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '@/lib/trpc';
import { getActiveKey, hydrateKeyring } from '@/lib/keyring';
import { apiUrl, adoptMachineFromUrl } from '@/lib/api-base';
import { AppShellSkeleton } from '@/components/app-shell-skeleton';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';
import { ChatCacheRoot } from '@/components/chat-cache-root';
import { announceReady, installNativeBridge, isNativeShell } from '@/lib/native-bridge';
import { isStandalone } from '@/lib/shortcuts';
import { installImeDebug } from '@/lib/ime-debug';
import { watchDashboardReach } from '@/lib/dashboard-reach';

// Key storage moved to lib/keyring (multi-machine browser keyring). Re-export
// the active-key getter so any importer of `@/app/providers` keeps working.
export { getActiveKey } from '@/lib/keyring';

type TrpcClient = ReturnType<typeof trpc.createClient>;

function makeTrpcClient(): TrpcClient {
  // A notification tap can name the workspace it came from (`?m=<machineId>`).
  // Apply it HERE — before the client below reads the backend — so the whole
  // tab comes up on the right deployment instead of switching after paint.
  adoptMachineFromUrl();
  // Both ends of the split share the transport config — only the batching
  // differs.
  const http = {
    // The active keyring entry decides WHICH deployment this tab talks to —
    // '' (this origin) for a local machine, `https://other-host` for one on a
    // second dashboard. Read once here rather than per request because
    // switching entries is a full page reload, so it cannot change under a
    // live client.
    url: apiUrl('/api/trpc'),
    transformer: superjson,
    headers() {
      return { 'x-asst-key': getActiveKey() };
    },
  };
  return trpc.createClient({
    links: [
      loggerLink({ enabled: () => false }),
      // Batching shares one HTTP response across the queries that happen to
      // land in the same tick, so every query in the batch waits for the
      // SLOWEST one. chat.getSession (single-row PK lookup, tens of ms) was
      // routinely held hostage by a same-batch listSessions / listMessages
      // (~240 KB). Those two (plus chat.queue, the small poll next to it) go
      // out unbatched and return on their own; everything else keeps batching.
      splitLink({
        condition: (op) => op.path === 'chat.getSession' || op.path === 'chat.queue',
        true: httpLink(http),
        false: httpBatchLink(http),
      }),
    ],
  });
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 4000, refetchOnWindowFocus: false },
      },
    });
    // Record whether this tab can currently reach the dashboard, so a status dot
    // can tell "the gateway went quiet" from "my own poll never came back". Here
    // rather than in a component because it must see every fetch, including the
    // ones issued by views that are not mounted right now. Never unsubscribed —
    // it lives exactly as long as the client does. See lib/dashboard-reach.
    watchDashboardReach(client.getQueryCache());
    return client;
  });

  // The keyring decides WHICH deployment this tab talks to, and inside the iOS
  // shell the keyring lives in the device Keychain, which answers asynchronously.
  // So the client is built only once `hydrateKeyring()` has settled, and until
  // then the page shows the same empty frame the auth gate shows — on the server
  // and on the client's first commit alike, so the two agree.
  //
  // Building it in the first render (a `useState` initialiser) read the keyring
  // before the Keychain had answered: on the second launch of TestFlight build 7
  // — keyring in the Keychain, localStorage empty — the client was pinned to
  // THIS origin, sent the other deployment's key here, and every request came
  // back "invalid key" (2026-09-05).
  const [trpcClient, setTrpcClient] = useState<TrpcClient | null>(null);

  // Expose the native-shell API (APNs token intake + deep links). No-op in a
  // browser — it just parks an object the shell would have called. Declared
  // before the effect below on purpose: effects run in this order, and the
  // Keychain's answer arrives through the API this one installs.
  useEffect(() => installNativeBridge(), []);

  useEffect(() => {
    let cancelled = false;
    void hydrateKeyring().finally(() => {
      if (cancelled) return;
      // Updater form on purpose: the client is a callable proxy, and a bare
      // `setTrpcClient(client)` would be taken for an updater and called.
      setTrpcClient(() => makeTrpcClient());
      // Everything the shell learns from the keyring — including the `ready`
      // that makes it replay a push token — goes out only now that it is read.
      announceReady();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Opt-in IME probe for the "stuck typing English" bug class — zero cost
  // unless localStorage['hermit:ime-debug']='1'. See lib/ime-debug.ts.
  useEffect(() => installImeDebug(), []);

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
    const appLike = isStandalone() || isNativeShell();

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
      const ot = vv?.offsetTop ?? 0;
      const keyboardOpen = vh < sh - 120;
      // Keyboard open: the shell bottom should sit at the keyboard top, which is
      // the BOTTOM edge of the visual viewport = offsetTop + height (iOS offsets
      // the visual viewport when the keyboard appears, so height alone leaves the
      // composer floating too high). Otherwise fill the real screen.
      setVar(keyboardOpen ? ot + vh : sh);
      // Whether the keyboard is COVERING the page is a different question from the
      // one above, and it needs a different measurement. `vh < sh - 120` compares
      // the window to the whole DISPLAY: right for --app-h (which wants to fill the
      // real screen), permanently true for an installed desktop PWA window, an iPad
      // in Split View, or the shell in landscape. Compare the visual viewport to
      // the LAYOUT viewport instead — `innerHeight` does not shrink for the iOS
      // keyboard, so the gap between them IS the keyboard, whatever size the window
      // is. Pure geometry, so it also cannot latch: an earlier version ANDed in
      // "an input is focused", and when that input was removed from the DOM WebKit
      // fired neither focusout nor focusin, leaving the class stuck on.
      document.documentElement.classList.toggle('kb-open', appLike && vh < ih - 120);
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
      document.documentElement.classList.remove('kb-open');
    };
  }, []);

  return (
    // Theme: follows the OS by default; the Settings → Appearance tab can pin
    // light/dark. next-themes toggles the `.dark` class on <html> (no flash).
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {trpcClient ? (
        <trpc.Provider client={trpcClient} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <ConfirmProvider>
              {children}
              <KeyboardShortcuts />
              {/* Chat cache: one background sync for the whole app, and the global
                  search overlay it feeds. Both are singletons behind these mounts. */}
              <ChatCacheRoot />
            </ConfirmProvider>
          </QueryClientProvider>
        </trpc.Provider>
      ) : (
        <AppShellSkeleton />
      )}
    </ThemeProvider>
  );
}
