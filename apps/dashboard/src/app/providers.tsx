'use client';

import { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, loggerLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '@/lib/trpc';

const KEY_STORAGE = 'asst-dashboard-key';

export function getStoredKey(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(KEY_STORAGE) ?? '';
}
export function setStoredKey(k: string) {
  if (typeof window === 'undefined') return;
  if (k) localStorage.setItem(KEY_STORAGE, k);
  else localStorage.removeItem(KEY_STORAGE);
}

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
            return { 'x-asst-key': getStoredKey() };
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

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
