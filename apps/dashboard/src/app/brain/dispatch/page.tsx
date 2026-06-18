'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { SessionPane } from '@/app/chat/page';

// Brain · Dispatches — like the chat: the dispatch conversation LIST lives in the
// sidebar (RecentDispatchSessions), and this main pane shows the selected thread
// (the chat's own SessionPane) or an empty state. A ?session= that isn't actually
// a dispatch is ignored (defensive — mirrors the /brain session guard).
export default function BrainDispatchPage() {
  return (
    <Suspense fallback={null}>
      <BrainDispatchInner />
    </Suspense>
  );
}

function BrainDispatchInner() {
  const sessionParam = useSearchParams().get('session');
  // Validate the id is one of the brain's dispatch sessions before rendering it.
  // Same query key the sidebar already loads, so it's a cache hit on click.
  const sessions = trpc.chat.listSessions.useQuery({}, { enabled: !!sessionParam, refetchInterval: 10_000 });
  const isDispatch =
    !!sessionParam &&
    (sessions.data ?? []).some(
      (s) => s.id === sessionParam && (s.origin === 'dispatch' || (s.title ?? '').startsWith('Brain →')),
    );

  if (sessionParam && isDispatch) return <SessionPane key={sessionParam} sessionId={sessionParam} />;

  const loading = !!sessionParam && sessions.isPending;
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span aria-hidden className="logo-crab-mono h-5 w-5 bg-foreground" />
        <span className="text-sm font-medium text-foreground">Brain · Dispatches</span>
      </header>
      <div className="flex-1 min-h-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {loading
          ? 'loading…'
          : sessionParam
            ? 'That conversation isn’t a dispatch.'
            : 'Select a dispatch on the left to view the conversation Brain handed off.'}
      </div>
    </div>
  );
}
