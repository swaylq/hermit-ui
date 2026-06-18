'use client';

import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { SessionPane } from '@/app/chat/page';
import { ArrowLeft } from 'lucide-react';

// Brain · Dispatches — the brain's one-shot delegations, as a chat-style
// master/detail (consistent with the chat UI): the list of dispatch
// conversations on the left, the selected one's full thread on the right (the
// same SessionPane the chat uses). Dispatch sessions are marked origin:'dispatch'
// and kept OUT of the worker chat recents — this view is their home.
export default function BrainDispatchPage() {
  const sessions = trpc.chat.listSessions.useQuery({}, { refetchInterval: 5_000 });
  const dispatches = useMemo(
    () =>
      (sessions.data ?? [])
        .filter((s) => s.origin === 'dispatch' || (s.title ?? '').startsWith('Brain →'))
        .sort((a, b) => new Date(b.lastMessageAt ?? b.startedAt).getTime() - new Date(a.lastMessageAt ?? a.startedAt).getTime()),
    [sessions.data],
  );
  const [selected, setSelected] = useState<string | null>(null);
  // Default into the most recent dispatch (like the chat landing) once loaded.
  useEffect(() => {
    setSelected((cur) => (cur == null && dispatches.length > 0 ? dispatches[0].id : cur));
  }, [dispatches]);
  const active = selected && dispatches.some((d) => d.id === selected) ? selected : null;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span aria-hidden className="logo-crab-mono h-5 w-5 bg-foreground" />
        <span className="text-sm font-medium text-foreground">Brain · Dispatches</span>
      </header>
      <div className="flex flex-1 min-h-0">
        {/* Left: dispatch conversation list (hides on mobile once one is open). */}
        <div
          className={cn(
            'w-full overflow-y-auto border-border bg-muted/10 sm:w-72 sm:shrink-0 sm:border-r',
            active && 'hidden sm:block',
          )}
        >
          {sessions.isPending ? (
            <p className="p-4 text-sm text-muted-foreground">loading…</p>
          ) : dispatches.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">
              No dispatches yet. When Brain delegates a one-shot task to an agent, it appears here.
            </p>
          ) : (
            <ul className="space-y-1 p-2">
              {dispatches.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(s.id)}
                    title={s.title ?? undefined}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors cursor-pointer',
                      active === s.id ? 'bg-sidebar-accent' : 'hover:bg-accent/60',
                    )}
                  >
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', s.alive ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500')} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-foreground">{s.title || s.agentName}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{s.alive ? 'running' : 'done'} · {s.agentName}</div>
                    </div>
                    <span className="shrink-0 text-[10px] font-mono tabular-nums text-muted-foreground/60">{relTime(s.lastMessageAt ?? s.startedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* Right: the selected dispatch's full conversation (the chat's SessionPane). */}
        <div className={cn('flex-1 min-w-0 flex flex-col', !active && 'hidden sm:flex')}>
          {active ? (
            <>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="sm:hidden flex h-9 shrink-0 items-center gap-1 border-b border-border px-3 text-xs text-muted-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Dispatches
              </button>
              <div className="flex flex-1 min-h-0 flex-col">
                <SessionPane key={active} sessionId={active} />
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
              {dispatches.length === 0 ? 'No dispatches yet.' : 'Select a dispatch to view its conversation.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
