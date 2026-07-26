'use client';

// Single mount point for the chat cache: starts the background prose sync and
// hosts the global search overlay. Rendered once in providers, so the sync runs
// regardless of which route the user is on (search has to cover everything the
// moment it's opened, not just after visiting /chat).
//
// Renders nothing until the overlay is opened.

import { GlobalSearchHost } from '@/components/chat/global-search';
import { useChatCacheSync } from '@/lib/chat-cache/use-chat-cache';

export function ChatCacheRoot() {
  useChatCacheSync();
  return <GlobalSearchHost />;
}
