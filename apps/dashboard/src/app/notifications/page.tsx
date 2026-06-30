'use client';

// Notifications inbox — one time-sorted list of everything unread across all of
// the machine's agents (chat sessions + finished cron runs). Clicking a row jumps
// to its detail (a chat session, or the cron run auto-expanded) and the detail
// marks it read; we also fire the matching mark-read here so the dot clears at
// once. "Mark all read" clears the lot. Read-state is the SAME DB fields the chat
// sidebar / cron page use (ChatSession.lastReadAt, CronRun.readAt) — nothing here
// is a separate inbox state.

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Bell, MessageSquare, Clock, CheckCheck, AlertTriangle, Activity } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { SidebarMobileToggle } from '@/components/app-sidebar';

type FeedItem = {
  kind: 'chat' | 'cron' | 'host';
  key: string;
  agentName: string;
  title: string;
  preview: string | null;
  at: Date;
  sessionId?: string;
  cronId?: string;
  runId?: string;
  status?: string;
};

export default function NotificationsPage() {
  return (
    <Suspense fallback={null}>
      <NotificationsInner />
    </Suspense>
  );
}

function NotificationsInner() {
  const filter = useSearchParams().get('filter') ?? 'all';
  const utils = trpc.useUtils();
  const feed = trpc.notifications.feed.useQuery(undefined, { refetchInterval: 5_000 });
  const markChat = trpc.chat.markRead.useMutation();
  const markRun = trpc.cron.markRunRead.useMutation();
  const ackHost = trpc.hosts.ackAlert.useMutation({
    onSettled: () => {
      utils.notifications.feed.invalidate();
      utils.notifications.counts.invalidate();
    },
  });
  const markAll = trpc.notifications.markAllRead.useMutation({
    onMutate: async () => {
      // Optimistic: empty the feed + zero the counts so the list clears this frame.
      await Promise.all([utils.notifications.feed.cancel(), utils.notifications.counts.cancel()]);
      utils.notifications.feed.setData(undefined, { items: [], counts: { chat: 0, cron: 0, total: 0 } });
      utils.notifications.counts.setData(undefined, { chat: 0, cron: 0, total: 0 });
    },
    onSettled: () => {
      utils.notifications.feed.invalidate();
      utils.notifications.counts.invalidate();
    },
  });

  const all = feed.data?.items ?? [];
  const items = (filter === 'chat' || filter === 'cron' ? all.filter((i) => i.kind === filter) : all) as FeedItem[];
  const total = feed.data?.counts.total ?? 0;

  function open(item: FeedItem) {
    // Fire the matching mark-read (best-effort) then jump to the detail, which also
    // marks it read on arrival (chat pane on open / cron run on auto-expand).
    if (item.kind === 'chat' && item.sessionId) {
      markChat.mutate({ sessionId: item.sessionId });
      window.location.href = `/chat?session=${encodeURIComponent(item.sessionId)}`;
    } else if (item.kind === 'cron' && item.cronId && item.runId) {
      markRun.mutate({ runId: item.runId });
      window.location.href = `/cron?id=${encodeURIComponent(item.cronId)}&run=${encodeURIComponent(item.runId)}`;
    } else if (item.kind === 'host') {
      // No detail page — clicking a host alert just acknowledges it (the chip +
      // panel are where the live numbers live).
      ackHost.mutate();
    }
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <Bell className="h-[18px] w-[18px] text-foreground" />
        <span className="text-sm font-medium text-foreground">Notifications</span>
        {total > 0 && <span className="text-xs text-muted-foreground tabular-nums">· {total}</span>}
        <button
          type="button"
          onClick={() => markAll.mutate()}
          disabled={total === 0 || markAll.isPending}
          className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
        >
          <CheckCheck className="h-3.5 w-3.5" />
          Mark all read
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {feed.isPending ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-20 text-center text-muted-foreground">
            <CheckCheck className="h-7 w-7 opacity-50" />
            <p className="text-sm">You&rsquo;re all caught up.</p>
          </div>
        ) : (
          <ul className="p-2 space-y-0.5 max-w-3xl mx-auto">
            {items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => open(item)}
                  className="group w-full text-left flex gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/60 transition-colors cursor-pointer"
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground">
                    {item.kind === 'chat' ? <MessageSquare className="h-4 w-4" /> : item.kind === 'host' ? <Activity className="h-4 w-4 text-rose-500" /> : <Clock className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground/80 truncate">{item.agentName}</span>
                      <span className="uppercase tracking-wide">{item.kind}</span>
                      {item.kind === 'cron' && (item.status === 'fail' || item.status === 'error') && (
                        <span className="inline-flex items-center gap-0.5 text-rose-500">
                          <AlertTriangle className="h-3 w-3" /> failed
                        </span>
                      )}
                      <span className="ml-auto shrink-0 tabular-nums">{relTime(item.at)}</span>
                    </div>
                    <div className="text-sm font-medium text-foreground truncate">{item.title}</div>
                    {item.preview && (
                      <div className="text-xs text-muted-foreground line-clamp-2 [overflow-wrap:anywhere]">{item.preview}</div>
                    )}
                  </div>
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-rose-500" aria-hidden="true" title="unread" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
