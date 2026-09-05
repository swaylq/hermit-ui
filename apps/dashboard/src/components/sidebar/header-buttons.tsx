'use client';

// The two icon buttons in the sidebar header: Brain (the hermit-crab → the /brain
// orchestrator panel) and Settings (→ the Settings area). Both are rendered by
// AppSidebar.
//
// A third used to sit here — a bell with an unread badge, opening an in-dashboard
// notifications inbox. Real push (Web Push · APNs · Bark) reaches the phone now,
// so the inbox was removed on 2026-09-05 rather than kept as a second, weaker
// copy of the same information.

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Settings } from 'lucide-react';
import { SETTINGS_HREFS, SETTINGS_ENTRY_HREF } from '@/lib/settings-nav';
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
