'use client';

import { Suspense, lazy, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Trash2, Check, X, MessageSquare } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { AgentDetailBody, AgentDetailTabs, type DetailTab } from '@/components/agent-detail-sheet';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { useScope } from '@/lib/use-scope';
import { ShareAgentButton } from '@/components/share-agent-dialog';

// Only reachable via `?new=1` / `?import=1`; the normal entry is `?name=…`. Kept
// out of this route's first-load scripts and warmed after paint, so the sidebar's
// "New agent" still opens instantly on a warm page. (Same shape as /chat's
// NewChatPane.) Fallback mirrors the pane's own frame so nothing jumps.
const AddAgentPane = lazy(() => import('@/components/add-agent-pane').then((m) => ({ default: m.AddAgentPane })));

// Resolves to the SAME chunk React.lazy asks for — a head start, not a second
// download. After first paint only (requestIdleCallback isn't in Safari < 16.4),
// so it never competes with the detail pane this route actually opens on.
if (typeof window !== 'undefined') {
  const warm = () => { void import('@/components/add-agent-pane'); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(warm);
  else setTimeout(warm, 1500);
}

// Same 12px header row + centered max-w-md card as the real pane, so swapping the
// chunk in doesn't move anything. Keeps SidebarMobileToggle so a slow link can't
// strand a phone on a pane with no way back.
function AddAgentFallback() {
  return (
    <div className="flex flex-1 flex-col min-h-0" aria-busy="true">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-medium text-foreground">Add agent</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto pwa-safe-b">
        <div className="min-h-full flex flex-col items-center justify-center gap-4 p-4 sm:p-6">
          <div className="h-9 w-[136px] rounded-lg border border-border bg-card" />
          <div className="w-full max-w-md h-[420px] rounded-2xl border border-border bg-card shadow-sm" />
        </div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  return (
    <Suspense fallback={null}>
      <AgentsPageInner />
    </Suspense>
  );
}

function AgentsPageInner() {
  const search = useSearchParams();
  const router = useRouter();
  const nameParam = search.get('name');
  const showNew = !!search.get('new');
  const showImport = !!search.get('import');
  // A scoped agent-share session can't call these machine-wide queries (they 403);
  // disable them. The page still renders the one agent's detail via ?name= (scoped).
  const scope = useScope();

  // Sidebar owns the agent list now; this page is just the right pane. Still
  // need the list here for the default-landing redirect (pick the first agent
  // when no `?name=` is set).
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 30_000, enabled: !scope.scoped });
  // Poll fast only while something is in flight (tracking its resolution); idle —
  // the common case, no pending request — backs off hard. The create/delete flows
  // already invalidate this query, so a fresh pending shows immediately regardless.
  const pending = trpc.agents.pendingRequests.useQuery(undefined, {
    enabled: !scope.scoped,
    refetchInterval: (q) => (((q.state.data as unknown[] | undefined)?.length ?? 0) > 0 ? 2_000 : 12_000),
  });
  // Tab lives here (not in AgentMain) so it PERSISTS across agent switches —
  // AgentsPageInner doesn't remount on ?name= soft-nav, whereas AgentMain (keyed
  // by nameParam) does. Switching agents keeps Detail on Detail, Files on Files.
  const [tab, setTab] = useState<DetailTab>('detail');

  // Default landing: redirect to first agent so the area isn't blank. Mirrors
  // what /chat does for sessions.
  useEffect(() => {
    if (showNew || showImport || nameParam) return;
    // Skip the orchestrator (义脑) — it has its own /brain panel, not this list.
    const first = agents.data?.find((a) => !a.isOrchestrator);
    if (first) router.replace(`/agents?name=${encodeURIComponent(first.name)}`);
  }, [showNew, showImport, nameParam, agents.data, router]);

  if (showNew || showImport) {
    return (
      <Suspense fallback={<AddAgentFallback />}>
        <AddAgentPane
          initialMode={showImport ? 'import' : 'new'}
          onClose={() => router.replace(nameParam ? `/agents?name=${encodeURIComponent(nameParam)}` : '/agents')}
        />
      </Suspense>
    );
  }
  if (nameParam) {
    // key remounts AgentMain on switch — resets scroll + edit drafts cleanly.
    return <AgentMain key={nameParam} name={nameParam} pendingRequests={pending.data ?? []} tab={tab} setTab={setTab} />;
  }

  // Empty state — sidebar shows skeletons/list, this is the right pane when
  // there are no agents yet (or while the list is loading).
  return (
    <div className="flex flex-1 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0 lg:hidden">
        <SidebarMobileToggle />
      </header>
      <div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground">
        {agents.isPending ? 'loading…' : 'No agents yet — start with “New agent” in the sidebar.'}
      </div>
    </div>
  );
}

type PendingRequest = { id: string; kind: string; agentName: string; target: string | null; requestedAt: Date | string };

function AgentMain({
  name,
  pendingRequests,
  tab,
  setTab,
}: {
  name: string;
  pendingRequests: PendingRequest[];
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const scope = useScope();
  const requestDelete = trpc.agents.requestDelete.useMutation({
    onSuccess: () => {
      utils.agents.list.invalidate();
      utils.agents.listTrashed.invalidate();
      utils.agents.pendingRequests.invalidate();
    },
  });
  const isDeleting = pendingRequests.some((p) => p.kind === 'delete' && p.agentName === name);
  const isScaffolding = pendingRequests.some((p) => p.kind === 'create' && p.agentName === name);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="h-12 px-3 sm:px-4 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-semibold text-foreground font-mono truncate">{name}</span>
          {isScaffolding && (
            <span className="text-[11px] text-muted-foreground animate-pulse">scaffolding…</span>
          )}
          {isDeleting && (
            <span className="text-[11px] text-amber-500 animate-pulse">moving to recycle bin…</span>
          )}
        </div>
        <AgentDetailTabs tab={tab} setTab={setTab} />
        <div className="flex-1" />
        {!scope.scoped && <ShareAgentButton name={name} />}
        <Link
          href={`/chat?agent=${encodeURIComponent(name)}`}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          title={`chat with ${name}`}
          aria-label={`chat with ${name}`}
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </Link>
        {!scope.scoped && (
          <ConfirmDeleteButton
            name={name}
            disabled={isDeleting}
            onConfirm={() => {
              requestDelete.mutate({ name });
              // After delete is queued, bounce back to /agents so the default
              // redirect lands on whichever agent remains.
              setTimeout(() => router.replace('/agents'), 50);
            }}
          />
        )}
      </header>
      <div className="flex-1 min-h-0 bg-background">
        <AgentDetailBody name={name} tab={tab} />
      </div>
    </div>
  );
}

// Two-step header soft-delete (→ recycle bin): first click arms it, second click
// confirms; auto-disarms. The agent is recoverable from the sidebar Recycle bin.
function ConfirmDeleteButton({
  name,
  disabled,
  onConfirm,
}: {
  name: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed) {
    return (
      <span className="inline-flex items-center gap-0.5 animate-in fade-in-0">
        <button
          type="button"
          onClick={() => { setArmed(false); onConfirm(); }}
          className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs font-medium text-amber-600 hover:bg-amber-500/10 transition-colors cursor-pointer"
        >
          <Check className="h-3.5 w-3.5" /> recycle bin
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          aria-label="cancel"
          className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:bg-accent transition-colors cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      disabled={disabled}
      title={`move ${name} to recycle bin`}
      aria-label={`move ${name} to recycle bin`}
      className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:bg-amber-500/10 hover:text-amber-600 transition-colors cursor-pointer disabled:opacity-40"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}
