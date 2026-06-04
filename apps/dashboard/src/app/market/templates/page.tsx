'use client';

import { Package } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { relTime } from '@/lib/format';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarMobileToggle } from '@/components/app-sidebar';

export default function MarketTemplatesPage() {
  const templates = trpc.market.listTemplates.useQuery(undefined, { refetchInterval: 15_000 });

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="border-b border-border px-4 h-12 flex items-center gap-2 shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-semibold text-foreground">Marketplace · Templates</span>
      </header>

      <ScrollArea className="flex-1 min-h-0 bg-background">
        <div className="p-4">
          {(templates.data?.length ?? 0) === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-20 text-muted-foreground">
              <Package className="h-10 w-10 mb-3 opacity-30" aria-hidden="true" />
              <p className="text-sm">还没有 template。</p>
              <p className="mt-1 text-xs">D 阶段会从 agent 凝练发布到这里。</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {templates.data!.map((t) => (
                <div key={t.id} className="rounded-lg border bg-card p-3 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">{t.displayName}</span>
                    <span className="shrink-0 text-[11px] font-mono text-muted-foreground/70">v{t.latestVersion}</span>
                  </div>
                  <span className="text-[11px] font-mono text-muted-foreground/60 truncate">{t.slug}</span>
                  {t.description && <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>}
                  {t.sourceAgent && <span className="text-[10px] text-muted-foreground/50">from {t.sourceAgent}</span>}
                  <span className="text-[10px] text-muted-foreground/50 mt-auto pt-1">updated {relTime(t.updatedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
