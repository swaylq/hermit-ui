'use client';

// Single mount point for the chat cache: starts the background prose sync and
// hosts the global search overlay. Rendered once in providers, so the sync runs
// regardless of which route the user is on (search has to cover everything the
// moment it's opened, not just after visiting /chat).
//
// Renders nothing until the overlay is opened.

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { onOpenGlobalSearch } from '@/lib/chat-cache/search-bus';
import { useChatCacheSync } from '@/lib/chat-cache/use-chat-cache';

// The overlay renders null until ⌘K / the sidebar magnifier opens it, yet its
// chunk (Overlay + base-ui's Select popup engine) rode every route's blocking
// first load. Load it on first open instead: the open state lives here because
// the event that triggers the load is already dispatched before the chunk (and
// with it any listener inside) exists. Kept mounted after the first open so
// closing doesn't throw the loaded chunk away.
const GlobalSearchHost = lazy(() =>
  import('@/components/chat/global-search').then((m) => ({ default: m.GlobalSearchHost })),
);

export function ChatCacheRoot() {
  useChatCacheSync();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchEverOpened = useRef(false);
  useEffect(
    () =>
      onOpenGlobalSearch(() => {
        searchEverOpened.current = true;
        setSearchOpen(true);
      }),
    [],
  );
  if (!searchEverOpened.current) return null;
  return (
    <Suspense fallback={null}>
      <GlobalSearchHost open={searchOpen} onClose={() => setSearchOpen(false)} />
    </Suspense>
  );
}
