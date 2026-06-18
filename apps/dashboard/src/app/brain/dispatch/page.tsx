'use client';

import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { ArrowRight } from 'lucide-react';

// Brain · Dispatches — the record of one-shot tasks the brain has handed to other
// agents. Dispatch sessions live on the TARGET agent and are marked origin:
// 'dispatch' by the dispatch tool; clicking opens that agent's conversation.
// (The "Brain →" title-prefix fallback keeps pre-origin sessions visible during
// the transition — drop it once all dispatches carry the origin marker.)
export default function BrainDispatchPage() {
  const sessions = trpc.chat.listSessions.useQuery({}, { refetchInterval: 5_000 });
  const dispatches = (sessions.data ?? [])
    .filter((s) => s.origin === 'dispatch' || (s.title ?? '').startsWith('Brain →'))
    .sort((a, b) => new Date(b.lastMessageAt ?? b.startedAt).getTime() - new Date(a.lastMessageAt ?? a.startedAt).getTime());
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span aria-hidden className="logo-crab-mono h-5 w-5 bg-foreground" />
        <span className="text-sm font-medium text-foreground">Brain · Dispatches</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-4 sm:p-6">
          <p className="mb-3 text-xs text-muted-foreground">
            One-shot tasks Brain has handed to other agents. Click one to open that agent&apos;s conversation.
          </p>
          {sessions.isPending ? (
            <p className="text-sm text-muted-foreground">loading…</p>
          ) : dispatches.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              No dispatches yet. When Brain delegates a one-shot task to an agent, it appears here.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {dispatches.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/chat?session=${encodeURIComponent(s.id)}`}
                    className="group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-accent cursor-pointer"
                    title={s.title ?? undefined}
                  >
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', s.alive ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500')} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-foreground">{s.title}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{s.alive ? 'running' : 'done'} · {s.agentName}</div>
                    </div>
                    <span className="shrink-0 text-[10px] font-mono tabular-nums text-muted-foreground/60">{relTime(s.lastMessageAt ?? s.startedAt)}</span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
