'use client';

// The brain-mode sidebar (shown on /brain). Extracted verbatim from
// app-sidebar.tsx (P2-4); behaviour identical. BrainSidebar and
// RecentDispatchSessions are rendered by AppSidebar; RecentBrainSessions is
// private to this module.

import { useState, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { sessionRecencyAt, sessionRecencyMs } from '@/lib/session-recency';
import { sessionStatusView } from '@/lib/session-status';
import { dashboardReach } from '@/lib/dashboard-reach';
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
    (a, b) => sessionRecencyMs(b) - sessionRecencyMs(a),
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
          <p className="px-2 py-2 text-xs text-muted-foreground animate-in fade-in-0 duration-150">No conversations yet — use New Brain chat above.</p>
        ) : (
          <ul className="space-y-px animate-in fade-in-0 duration-150">
            {rows.map((s) => {
              const active = activeId === s.id;
              const status = sessionStatusView(s, dashboardReach());
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
                      {/* Same verdict as the chat sidebar. This used to read
                          `alive` raw, which on claude-sdk means "the gateway
                          happens to hold a handle" rather than anything about
                          the conversation — solid green for a session whose
                          turn ended hours ago, hollow for one it simply has not
                          re-attached since the last restart. */}
                      <span
                        className={cn(
                          'mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 transition-colors',
                          status.dot,
                          status.pulse && 'animate-pulse',
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-1.5">
                          <span className={cn('flex-1 truncate text-[13px]', active ? 'text-sidebar-foreground font-medium' : 'text-sidebar-foreground/85')}>
                            {s.title || s.preview || 'Brain chat'}
                          </span>
                          <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                            {relTime(sessionRecencyAt(s))}
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

// Brain's dispatch conversations (origin:'dispatch') in the sidebar when on
// /brain/dispatch — the same place the chat keeps its recents. Each links the
// thread into the main pane (?session=); the worker chat recents filter these out.
export function RecentDispatchSessions() {
  const search = useSearchParams();
  const activeId = search.get('session');
  const sessions = trpc.chat.listSessions.useQuery({}, { refetchInterval: 5_000 });
  const rows = useMemo(
    () =>
      (sessions.data ?? [])
        .filter((s) => s.origin === 'dispatch' || (s.title ?? '').startsWith('Brain →'))
        .sort((a, b) => sessionRecencyMs(b) - sessionRecencyMs(a)),
    [sessions.data],
  );
  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>Dispatches</span>
        <span className="tabular-nums text-muted-foreground/50">{rows.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {sessions.isPending ? (
          <div className="space-y-1 px-1 pt-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 rounded-md bg-sidebar-accent/40 animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground animate-in fade-in-0 duration-150">No dispatches yet. When Brain delegates a one-shot task, it appears here.</p>
        ) : (
          <ul className="space-y-px animate-in fade-in-0 duration-150">
            {rows.map((s) => {
              const active = activeId === s.id;
              const label = s.title || `Brain → ${s.agentName}`;
              // A dispatch is a one-shot task, so the question is only "still
              // going?". That was read off `alive`, which answers a different
              // question on claude-sdk: the handle is a gateway-memory fact, so
              // a finished dispatch whose handle was still warm pulsed amber
              // "running", and one the gateway had not re-attached since its
              // last restart read green "done" while its turn was unfinished.
              // Same verdict as every other session dot now; only the wording
              // stays dispatch-shaped.
              const status = sessionStatusView(s, dashboardReach());
              const phase =
                status.key === 'working' ? 'running' : status.key === 'stale' ? 'unknown' : 'done';
              return (
                <li key={s.id}>
                  <Link
                    href={`/brain/dispatch?session=${encodeURIComponent(s.id)}`}
                    className={cn(
                      'group block w-full rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors',
                      active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
                    )}
                    title={label}
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <span
                        className={cn('mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 transition-colors', status.dot, status.pulse && 'animate-pulse')}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-1.5">
                          <span className={cn('flex-1 truncate text-[13px]', active ? 'text-sidebar-foreground font-medium' : 'text-sidebar-foreground/85')}>
                            {label}
                          </span>
                          <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                            {relTime(sessionRecencyAt(s))}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-[10px] font-mono text-muted-foreground/70 tabular-nums">
                          {phase} · {s.agentName}
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
