'use client';

// The three icon buttons in the sidebar header: Brain (the hermit-crab → the
// /brain orchestrator panel), Settings (→ the Settings area), and Notifications
// (the bell → /notifications, with an unread badge). Extracted verbatim from
// app-sidebar.tsx (P2-4); behaviour identical. All three are rendered by AppSidebar.

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Settings, Bell } from 'lucide-react';
import { SETTINGS_HREFS, SETTINGS_ENTRY_HREF } from '@/lib/settings-nav';
import { useNotifCounts } from './notifications-nav';

// The hermit-crab button in the sidebar header → the dedicated 义脑 / Brain panel
// (/brain). The orchestrator lives there, kept out of the worker agent lists. The
// icon is the monochrome woodcut crab (CSS mask, bg-current) so it tints like the
// sibling header icons (muted → foreground on hover) and follows the theme.
export function BrainButton({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const active = pathname.startsWith('/brain');
  return (
    <Link
      href="/brain"
      title="Brain"
      aria-label="Brain"
      className={cn(
        'group inline-flex items-center justify-center p-1.5 rounded-md transition-colors cursor-pointer shrink-0',
        active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent',
        collapsed && 'lg:hidden',
      )}
    >
      {/* Crab: monochrome by default (tints with text color), the full-color logo
          crossfades in on hover / when active. Sized to match the sibling header
          icons (h-4 w-4). */}
      <span aria-hidden="true" className="relative h-4 w-4 shrink-0">
        <span
          className={cn(
            'absolute inset-0 logo-crab-mono bg-current transition-opacity',
            active ? 'opacity-0' : 'text-muted-foreground group-hover:opacity-0',
          )}
        />
        <span
          style={{ backgroundImage: 'url(/logo-crab.png)' }}
          className={cn(
            'absolute inset-0 bg-contain bg-center bg-no-repeat transition-opacity',
            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        />
      </span>
    </Link>
  );
}

// The Settings button in the sidebar header → the Settings area (/skills, its first
// tab). Sits right beside the Brain button, where Help used to be (Help is now a
// Settings sub-page). Highlights on any Settings route. Mirrors BrainButton's look.
export function SettingsButton({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const active = SETTINGS_HREFS.some((h) => pathname === h || pathname.startsWith(h + '/'));
  return (
    <Link
      href={SETTINGS_ENTRY_HREF}
      title="Settings"
      aria-label="Settings"
      className={cn(
        'inline-flex items-center justify-center p-1.5 rounded-md transition-colors cursor-pointer shrink-0',
        active ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
        collapsed && 'lg:hidden',
      )}
    >
      <Settings className="h-4 w-4" />
    </Link>
  );
}

// The bell button in the sidebar header → the Notifications inbox (/notifications).
// Sits right beside the Brain button. Carries a small rose badge with the total
// unread roll-up (chat sessions + cron runs) so the user sees pending items
// without entering. Mirrors BrainButton's active/hover treatment.
export function NotificationsButton({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const active = pathname.startsWith('/notifications');
  // Subscribe to the unread roll-up HERE (leaf) rather than in AppSidebar, so a
  // count tick re-renders just this badge, not the whole sidebar subtree (P1-2).
  const { total: count } = useNotifCounts();
  return (
    <Link
      href="/notifications"
      title="Notifications"
      aria-label="Notifications"
      className={cn(
        'group relative inline-flex items-center justify-center p-1.5 rounded-md transition-colors cursor-pointer shrink-0',
        active ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
        collapsed && 'lg:hidden',
      )}
    >
      <Bell className="h-4 w-4" />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-rose-500 text-white text-[8px] font-mono tabular-nums leading-none"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}
