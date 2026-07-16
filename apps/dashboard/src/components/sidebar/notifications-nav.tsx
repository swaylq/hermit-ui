'use client';

// Notifications data + the /notifications-mode filter strip, split out of AppSidebar
// so the unread-count poll re-renders ONLY its consumers (the header bell badge and
// this filter strip) instead of the whole always-mounted sidebar subtree on every
// tick (docs/perf-backlog.md P1-2, finding C3). `useNotifCounts` is the single shared
// subscription — React Query dedupes both callers onto one query key / one poll.

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Bell, MessageSquare, Clock, type LucideIcon } from 'lucide-react';

const EMPTY_COUNTS = { chat: 0, cron: 0, total: 0 };

// Unread roll-up across the machine's agents (chat sessions + finished cron runs).
// The header bell badge and the filter strip both call this; React Query collapses
// them onto the same query key so it fires once. Cadence is 15s (was 5s at the
// sidebar root) — the badge feeds a single small number and notifications.counts is
// one of the app's hottest server queries, so a longer poll cuts the scan frequency
// 3x. Mutations that change unread state (markAllRead) invalidate the key, so the
// badge still updates instantly regardless of the interval.
export function useNotifCounts() {
  return trpc.notifications.counts.useQuery(undefined, { refetchInterval: 15_000 }).data ?? EMPTY_COUNTS;
}

// Notifications mode: filter the unread inbox by source. Counts come from
// useNotifCounts; the page filters the already-loaded feed client-side.
const NOTIF_FILTERS: Array<{ key: 'all' | 'chat' | 'cron'; href: string; label: string; icon: LucideIcon }> = [
  { key: 'all', href: '/notifications', label: 'All', icon: Bell },
  { key: 'chat', href: '/notifications?filter=chat', label: 'Chat', icon: MessageSquare },
  { key: 'cron', href: '/notifications?filter=cron', label: 'Cron', icon: Clock },
];

// The All / Chat / Cron source filters shown in the sidebar while on /notifications.
// The list + "Mark all read" live on the page; this is just the source filter. Owns
// its own counts subscription (via useNotifCounts) so a count tick re-renders only
// this strip, not AppSidebar. Only rendered on /notifications, so the old
// `onNotifications ? … : 'all'` guard collapses to a plain filter read.
export function NotificationsFilters({ collapsed }: { collapsed: boolean }) {
  const search = useSearchParams();
  const notifFilter = search.get('filter') ?? 'all';
  const notifCounts = useNotifCounts();
  return (
    <>
      <nav className="px-2 pt-2 space-y-0.5">
        {NOTIF_FILTERS.map((f) => {
          const active = notifFilter === f.key;
          const Icon = f.icon;
          const count = f.key === 'all' ? notifCounts.total : f.key === 'chat' ? notifCounts.chat : notifCounts.cron;
          return (
            <Link
              key={f.key}
              href={f.href}
              title={f.label}
              className={cn(
                'flex items-center gap-2.5 rounded-lg h-8 text-sm transition-colors cursor-pointer',
                collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3',
                active
                  ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className={cn('truncate flex-1', collapsed && 'lg:hidden')}>{f.label}</span>
              {count > 0 && (
                <span
                  className={cn(
                    'shrink-0 inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-mono tabular-nums leading-none',
                    collapsed && 'lg:hidden',
                  )}
                >
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="flex-1" />
    </>
  );
}
