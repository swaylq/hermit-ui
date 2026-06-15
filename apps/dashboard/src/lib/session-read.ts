'use client';

// Per-session read-state → the red "unread" dot. Read-state lives in the DB
// (ChatSession.lastReadAt), NOT browser localStorage, so the dot is identical on
// every device: marking a session read here clears it everywhere. The open chat
// pane stamps read via useMarkSessionRead(); the sidebar / agent-detail compute
// `unread = lastMessageAt > lastReadAt` from the same listSessions payload and
// reconcile on their 5s poll. See session-status.ts for how it renders.

import { useCallback, useRef } from 'react';
import { trpc } from '@/lib/trpc';

type ReadLike = { lastMessageAt?: Date | string | null; lastReadAt?: Date | string | null };

// A session is unread when its newest message is newer than the last time the
// user read it. No message → never unread. Never read (null) but has a message →
// unread.
export function isSessionUnread(s: ReadLike | null | undefined): boolean {
  if (!s?.lastMessageAt) return false;
  const msg = new Date(s.lastMessageAt).getTime();
  const read = s.lastReadAt ? new Date(s.lastReadAt).getTime() : 0;
  return msg > read;
}

// Returns a stable `markRead(sessionId)`. Optimistically stamps `lastReadAt` in
// the sidebar's listSessions cache so the dot drops this frame on this device,
// then debounces the DB write (a streaming turn fires one call per content block;
// collapse them into one write while still persisting the final read-state for
// other devices, which reconcile on their next poll).
export function useMarkSessionRead(): (sessionId: string) => void {
  const utils = trpc.useUtils();
  const patch = useCallback(
    (sessionId: string) => {
      utils.chat.listSessions.setData({}, (old) =>
        old?.map((s) => (s.id === sessionId ? { ...s, lastReadAt: new Date() } : s)),
      );
    },
    [utils],
  );
  // `mutate` is referentially stable across renders (react-query memoizes it), so
  // the returned `markRead` stays stable too — safe to list in an effect's deps.
  const { mutate } = trpc.chat.markRead.useMutation({
    // Re-apply after cancelling any in-flight poll so a refetch landing during the
    // debounce window can't momentarily flash the dot back on.
    onMutate: async ({ sessionId }) => {
      await utils.chat.listSessions.cancel();
      patch(sessionId);
    },
  });
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  return useCallback(
    (sessionId: string) => {
      if (!sessionId) return;
      patch(sessionId); // instant — don't wait for the debounce
      const existing = timers.current.get(sessionId);
      if (existing) clearTimeout(existing);
      timers.current.set(
        sessionId,
        setTimeout(() => {
          timers.current.delete(sessionId);
          mutate({ sessionId });
        }, 500),
      );
    },
    [patch, mutate],
  );
}
