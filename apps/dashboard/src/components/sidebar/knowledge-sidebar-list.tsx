'use client';

// The knowledge-mode sidebar list (shown on /knowledge): the master list of the
// knowledge-base master-detail layout (/knowledge/[slug] is the detail pane),
// each row linking to its editor. Extracted verbatim from app-sidebar.tsx
// (P2-4); behaviour identical. Rendered by AppSidebar.

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { BookOpen } from 'lucide-react';

// Knowledge bases in the sidebar when on /knowledge — the master list of a
// master-detail layout (the /knowledge/[slug] page is the detail pane), the same
// shape the chat keeps its session recents in. Each row links to its editor.
export function KnowledgeSidebarList() {
  const pathname = usePathname();
  const activeSlug = decodeURIComponent(pathname.split('/')[2] ?? '');
  const bases = trpc.knowledge.listBases.useQuery(undefined, { refetchInterval: 10_000 });
  const rows = bases.data ?? [];
  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>Knowledge bases</span>
        <span className="tabular-nums text-muted-foreground/50">{rows.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {bases.isPending ? (
          <div className="space-y-1 px-1 pt-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 rounded-md bg-sidebar-accent/40 animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No knowledge bases yet. Create one to give agents shared, on-demand reference docs.</p>
        ) : (
          <ul className="space-y-px">
            {rows.map((kb) => {
              const active = activeSlug === kb.slug;
              return (
                <li key={kb.id}>
                  <Link
                    href={`/knowledge/${encodeURIComponent(kb.slug)}`}
                    title={kb.name}
                    className={cn(
                      'group block w-full rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors',
                      active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
                    )}
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-1.5">
                          <span className={cn('flex-1 truncate text-[13px]', active ? 'text-sidebar-foreground font-medium' : 'text-sidebar-foreground/85')}>
                            {kb.name}
                          </span>
                          <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                            {kb.docCount}
                          </span>
                        </div>
                        {kb.intro && <div className="mt-0.5 truncate text-[10px] text-muted-foreground/70">{kb.intro}</div>}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
