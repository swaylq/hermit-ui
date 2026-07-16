'use client';

// A shared sidebar search box: a quick title/name filter over a list. Extracted
// verbatim from app-sidebar.tsx (P2-4) into components/sidebar/ as a reusable
// unit; behaviour identical. Consumed by RecentAgents and RecentCrons.

import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// Shared sidebar search box — a quick title/name filter over a list (Agents /
// Crons), mirroring the Recents search on /chat. Esc clears.
export function SidebarFindInput({ value, onChange, placeholder, label }: {
  value: string; onChange: (v: string) => void; placeholder: string; label: string;
}) {
  return (
    <div className="px-2 pb-1">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" aria-hidden="true" />
        <input
          data-sidebar-search
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onChange(''); }}
          placeholder={placeholder}
          aria-label={label}
          className={cn(
            'h-8 w-full rounded-lg border border-sidebar-border bg-sidebar/60 pl-7 text-[12px] text-sidebar-foreground/90 placeholder:text-muted-foreground/50 outline-none transition-colors hover:border-sidebar-foreground/20 focus-visible:border-sidebar-foreground/40 focus-visible:ring-1 focus-visible:ring-sidebar-foreground/15',
            value ? 'pr-7' : 'pr-2',
          )}
        />
        {value && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
