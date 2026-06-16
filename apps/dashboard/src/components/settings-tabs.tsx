'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { Boxes, BarChart3, Wrench, KeyRound, HardDriveUpload, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SidebarMobileToggle } from '@/components/app-sidebar';

// Settings sub-nav: Skills + Usage + Operations + Account login + File Station as
// tabs. Each tab is its own route but they read as one "Settings" area — the
// sidebar's single Settings nav entry highlights for all. Rendered as a thin
// strip above each page's own header.
const TABS = [
  { key: 'skills', label: 'Global Skills', href: '/skills', Icon: Boxes },
  { key: 'memory', label: 'Global Memory', href: '/global-memory', Icon: Brain },
  { key: 'usage', label: 'Usage', href: '/usage', Icon: BarChart3 },
  { key: 'ops', label: 'Operations', href: '/ops', Icon: Wrench },
  { key: 'login', label: 'Account Login', href: '/login-claude', Icon: KeyRound },
  { key: 'files', label: 'File Station', href: '/file-station', Icon: HardDriveUpload },
] as const;

export function SettingsTabs({ active }: { active: 'skills' | 'memory' | 'usage' | 'ops' | 'login' | 'files' }) {
  const activeRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    // On a phone the four tabs don't fit, so the strip scrolls horizontally —
    // bring the active tab into view (it'd otherwise sit off the right edge).
    // block:'nearest' keeps the page from jumping vertically.
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, []);
  return (
    <div className="shrink-0 border-b border-border h-10 flex items-center">
      {/* The sidebar toggle shares the tabs row on phones/tablets (the button is
          lg:hidden), so settings pages no longer waste a second line on it. Pinned
          left — outside the scroll area — while the tabs scroll past it. */}
      <SidebarMobileToggle className="ml-2.5 shrink-0" />
      <div className="flex items-center gap-1 px-2.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="px-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/60 hidden sm:inline">
          Settings
        </span>
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            ref={active === t.key ? activeRef : undefined}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 h-7 px-2.5 rounded-md text-[13px] whitespace-nowrap transition-colors',
              active === t.key
                ? 'bg-accent text-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <t.Icon className="h-3.5 w-3.5" /> {t.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
