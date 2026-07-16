'use client';

// The brain-mode sidebar (shown on /brain). Extracted verbatim from
// app-sidebar.tsx (P2-4); behaviour identical. BrainSidebar is rendered by
// AppSidebar; RecentBrainSessions is private to this module.

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { SquarePen } from 'lucide-react';

// ── Brain mode: the orchestrator's own chat system in the sidebar ─────────────
// On /brain the sidebar swaps to this (mirrors the market-mode swap): a "New 义脑
// chat" button + the brain's own conversations, kept separate from the worker
// session recents. The brain's chats open inside /brain (?session=), not /chat.
export function BrainSidebar({ collapsed }: { collapsed: boolean }) {
  const agents = trpc.agents.list.useQuery(undefined, { staleTime: 60_000 });
  const brain = (agents.data ?? []).find((a) => a.isOrchestrator);
  const create = trpc.chat.createSession.useMutation();
  const [busy, setBusy] = useState(false);
  const newChat = async () => {
    if (!brain || busy) return;
    setBusy(true);
    try {
      const s = await create.mutateAsync({ agentName: brain.name });
      window.location.href = `/brain?session=${encodeURIComponent(s.id)}`;
    } catch {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="px-2 mt-2">
        <button
          type="button"
          onClick={newChat}
          disabled={!brain || busy}
          title="New Brain chat"
          className={cn(
            'flex w-full items-center gap-2 rounded-lg h-9 text-sm font-medium transition-colors cursor-pointer',
            'border border-sidebar-border bg-sidebar hover:bg-sidebar-accent text-sidebar-foreground disabled:opacity-50',
            collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3',
          )}
        >
          <SquarePen className="h-4 w-4 shrink-0" />
          <span className={cn('truncate', collapsed && 'lg:hidden')}>{busy ? '…' : 'New Brain chat'}</span>
        </button>
      </div>
      {!collapsed && <RecentBrainSessions brainName={brain?.name} />}
    </>
  );
}

// The brain's own conversations — only the orchestrator's sessions, linking into
// /brain (not /chat). The worker recents filter these out, so this is their home.
function RecentBrainSessions({ brainName }: { brainName?: string }) {
  const search = useSearchParams();
  const activeId = search.get('session');
  const sessions = trpc.chat.listSessions.useQuery(
    { agentName: brainName },
    { enabled: !!brainName, refetchInterval: 5_000 },
  );
  const rows = [...(sessions.data ?? [])].sort(
    (a, b) => new Date(b.lastMessageAt ?? b.startedAt).getTime() - new Date(a.lastMessageAt ?? a.startedAt).getTime(),
  );
  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>Brain chats</span>
        <span className="tabular-nums text-muted-foreground/50">{rows.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {!brainName ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No Brain yet — set one up in the main area.</p>
        ) : sessions.isPending ? (
          <div className="space-y-1 px-1 pt-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 rounded-md bg-sidebar-accent/40 animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No conversations yet — use New Brain chat above.</p>
        ) : (
          <ul className="space-y-px">
            {rows.map((s) => {
              const active = activeId === s.id;
              return (
                <li key={s.id}>
                  <Link
                    href={`/brain?session=${encodeURIComponent(s.id)}`}
                    className={cn(
                      'group block w-full rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors',
                      active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
                    )}
                    title={s.title || s.preview || 'Brain chat'}
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <span
                        className={cn('mt-1.5 h-1.5 w-1.5 rounded-full shrink-0', s.alive ? 'bg-emerald-500' : 'border border-muted-foreground/40')}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-1.5">
                          <span className={cn('flex-1 truncate text-[13px]', active ? 'text-sidebar-foreground font-medium' : 'text-sidebar-foreground/85')}>
                            {s.title || s.preview || 'Brain chat'}
                          </span>
                          <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                            {relTime(s.lastMessageAt ?? s.startedAt)}
                          </span>
                        </div>
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
