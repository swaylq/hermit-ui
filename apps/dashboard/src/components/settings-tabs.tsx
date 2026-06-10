'use client';

import Link from 'next/link';
import { Boxes, BarChart3, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';

// Settings sub-nav: Skills + Usage + Operations as tabs. Each tab is its own
// route (/skills, /usage, /ops) but they read as one "Settings" area — the
// sidebar's single Settings nav entry highlights for all. Rendered as a thin
// strip above each page's own header.
const TABS = [
  { key: 'skills', label: 'Global Skills', href: '/skills', Icon: Boxes },
  { key: 'usage', label: 'Usage', href: '/usage', Icon: BarChart3 },
  { key: 'ops', label: 'Operations', href: '/ops', Icon: Wrench },
] as const;

export function SettingsTabs({ active }: { active: 'skills' | 'usage' | 'ops' }) {
  return (
    <div className="shrink-0 border-b border-border px-2.5 h-10 flex items-center gap-1">
      <span className="px-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/60 hidden sm:inline">
        Settings
      </span>
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cn(
            'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[13px] transition-colors',
            active === t.key
              ? 'bg-accent text-foreground font-medium'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <t.Icon className="h-3.5 w-3.5" /> {t.label}
        </Link>
      ))}
    </div>
  );
}
