'use client';

// The sidebar shown ONLY in a scoped agent-share session: just the one agent —
// its chats + a link into its files. No machine switcher, primary nav, Brain,
// Market, or terminal: a share holder can reach nothing but their agent (the
// server enforces it; this hides the rest). Reuses the SidebarProvider context so
// the pages' mobile hamburger still opens it.

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { SquarePen, Folder, KeyRound, LogOut } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { useSidebar } from '@/components/app-sidebar';
import { getKeyring, getActiveEntry, removeMachine } from '@/lib/keyring';
import { AddMachine } from './add-machine';

export function ScopedSidebar({ agentName }: { agentName: string }) {
  const { mobileOpen, setMobileOpen } = useSidebar();
  const pathname = usePathname();
  const search = useSearchParams();
  const activeSession = search.get('session');
  const onAgents = pathname.startsWith('/agents');
  const composingNew = pathname.startsWith('/chat') && !activeSession; // new-chat compose
  const sessions = trpc.chat.listSessions.useQuery({ agentName }, { refetchInterval: 5_000 });
  const rows = (sessions.data ?? []).filter((s) => !s.hiddenAt);
  const close = () => setMobileOpen(false);

  // An owner who opened a share link (they have OTHER workspaces) can leave the
  // scoped view; a pure recipient (this key is all they have) has nowhere to go.
  const canExit = typeof window !== 'undefined' && getKeyring().length > 1;
  const exit = () => {
    const me = getActiveEntry();
    if (me) removeMachine(me.id); // drop the share entry → active falls to a real workspace
    window.location.href = '/chat';
  };

  return (
    <>
      {/* mobile backdrop */}
      <div
        onClick={close}
        aria-hidden="true"
        className={cn(
          'lg:hidden fixed inset-0 z-40 bg-foreground/20 transition-opacity duration-150',
          mobileOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
      />
      <aside
        aria-label="navigation"
        className={cn(
          'bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col shrink-0',
          'fixed inset-y-0 left-0 z-50 w-[280px] transition-transform duration-200 ease-out pwa-safe-t pwa-safe-b',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          'lg:static lg:translate-x-0 lg:z-0 lg:w-[300px]',
        )}
      >
        {/* Header: agent name + a "shared" badge */}
        <div className="flex items-center gap-2 h-12 px-3 shrink-0 border-b border-sidebar-border">
          <span aria-hidden="true" className="logo-crab-mono h-4 w-4 shrink-0 bg-sidebar-foreground" />
          <span className="flex-1 min-w-0 truncate text-sm font-semibold font-mono text-sidebar-foreground">{agentName}</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-sidebar-accent px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
            <KeyRound className="h-2.5 w-2.5" /> shared
          </span>
        </div>

        {/* New chat + the agent's files */}
        <div className="px-2 pt-2 space-y-0.5">
          <Link
            href={`/chat?agent=${encodeURIComponent(agentName)}&new=1`}
            onClick={close}
            className={cn(
              'flex items-center gap-2.5 rounded-lg h-8 px-3 text-sm font-medium transition-colors cursor-pointer',
              composingNew ? 'bg-sidebar-accent text-sidebar-foreground' : 'bg-sidebar-accent/50 text-sidebar-foreground hover:bg-sidebar-accent/80',
            )}
          >
            <SquarePen className="h-4 w-4 shrink-0" /> New chat
          </Link>
          <Link
            href={`/agents?name=${encodeURIComponent(agentName)}`}
            onClick={close}
            className={cn(
              'flex items-center gap-2.5 rounded-lg h-8 px-3 text-sm transition-colors cursor-pointer',
              onAgents ? 'bg-sidebar-accent text-sidebar-foreground font-medium' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
            )}
          >
            <Folder className="h-4 w-4 shrink-0" /> Files
          </Link>
        </div>

        {/* This agent's chats */}
        <div className="flex-1 min-h-0 overflow-y-auto px-2 pt-3">
          <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Chats</div>
          {sessions.isPending ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">loading…</div>
          ) : rows.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No chats yet.</div>
          ) : (
            rows.map((s) => (
              <Link
                key={s.id}
                href={`/chat?session=${encodeURIComponent(s.id)}`}
                onClick={close}
                className={cn(
                  'flex flex-col gap-0.5 rounded-lg px-2.5 py-1.5 transition-colors cursor-pointer',
                  activeSession === s.id
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                )}
              >
                <span className="truncate text-sm">{s.title || s.preview || 'New chat'}</span>
                {s.lastMessageAt && <span className="text-[10px] text-muted-foreground/70">{relTime(s.lastMessageAt)}</span>}
              </Link>
            ))
          )}
        </div>

        {/* Footer: add a machine key (upgrade to full access) + exit if possible.
            A pure recipient (only this share) otherwise has no way to reach the
            login screen — the AddMachine button lets them paste a machine key and
            jump to the full app. The server still 403s scoped tokens. */}
        <div className="border-t border-sidebar-border p-2 shrink-0 space-y-0.5">
          <AddMachine onAdded={() => { window.location.href = '/chat'; }} label="Add a machine key" />
          {canExit && (
            <button
              type="button"
              onClick={exit}
              className="flex w-full items-center gap-2.5 rounded-lg h-8 px-3 text-sm text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground transition-colors cursor-pointer"
            >
              <LogOut className="h-4 w-4 shrink-0" /> Exit shared view
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
