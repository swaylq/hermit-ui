'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Plus, Trash2, Check, X, FolderPlus, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { AgentDetailBody } from '@/components/agent-detail-sheet';
import { SidebarMobileToggle } from '@/components/app-sidebar';

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

  // Sidebar owns the agent list now; this page is just the right pane. Still
  // need the list here for the default-landing redirect (pick the first agent
  // when no `?name=` is set).
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 10_000 });
  const pending = trpc.agents.pendingRequests.useQuery(undefined, { refetchInterval: 2_000 });

  // Default landing: redirect to first agent so the area isn't blank. Mirrors
  // what /chat does for sessions.
  useEffect(() => {
    if (showNew || showImport || nameParam) return;
    const first = agents.data?.[0];
    if (first) router.replace(`/agents?name=${encodeURIComponent(first.name)}`);
  }, [showNew, showImport, nameParam, agents.data, router]);

  if (showNew || showImport) {
    return (
      <AddAgentPane
        initialMode={showImport ? 'import' : 'new'}
        onClose={() => router.replace(nameParam ? `/agents?name=${encodeURIComponent(nameParam)}` : '/agents')}
      />
    );
  }
  if (nameParam) {
    // key remounts AgentMain on switch — resets scroll + edit drafts cleanly.
    return <AgentMain key={nameParam} name={nameParam} pendingRequests={pending.data ?? []} />;
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

function AgentMain({ name, pendingRequests }: { name: string; pendingRequests: PendingRequest[] }) {
  const router = useRouter();
  const utils = trpc.useUtils();
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
        <div className="flex-1" />
        <Link
          href={`/chat?agent=${encodeURIComponent(name)}`}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          title={`chat with ${name}`}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          Chat
        </Link>
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
      </header>
      <ScrollArea className="flex-1 min-h-0 bg-background">
        <div className="max-w-3xl w-full mx-auto">
          <AgentDetailBody name={name} />
        </div>
      </ScrollArea>
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
      <span className="inline-flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => { setArmed(false); onConfirm(); }}
          className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs font-medium text-amber-600 hover:bg-amber-500/10 cursor-pointer"
        >
          <Check className="h-3.5 w-3.5" /> recycle bin
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          aria-label="cancel"
          className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:bg-accent cursor-pointer"
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

// Unified "add agent" pane: a segmented toggle switches the creation method
// between a fresh scaffold and importing an existing folder. Replaces the
// separate sidebar New / Import buttons — Import now lives here as a tab.
function AddAgentPane({ initialMode, onClose }: { initialMode: 'new' | 'import'; onClose: () => void }) {
  const [mode, setMode] = useState<'new' | 'import'>(initialMode);
  return (
    <div className="flex flex-1 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-medium text-foreground">Add agent</span>
      </header>
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-4 sm:p-6">
        <div role="tablist" aria-label="creation method" className="inline-flex rounded-lg border border-border bg-card p-0.5 text-[13px] font-medium">
          {([['new', 'New'], ['import', 'Import']] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'px-4 h-8 rounded-md transition-colors cursor-pointer',
                mode === m ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === 'new' ? <NewAgentForm onClose={onClose} /> : <ImportAgentForm onClose={onClose} />}
      </div>
    </div>
  );
}

function NewAgentForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [templateId, setTemplateId] = useState('');
  const templates = trpc.market.listTemplates.useQuery();
  const router = useRouter();
  const utils = trpc.useUtils();
  const create = trpc.agents.requestCreate.useMutation({
    onSuccess: (_, vars) => {
      utils.agents.list.invalidate();
      // Drop the user on the new agent's detail so they can watch it spin up.
      router.replace(`/agents?name=${encodeURIComponent(vars.name)}`);
    },
  });
  const nameOk = /^[a-z][a-z0-9-]{0,30}$/.test(name);

  return (
        <form
          className="w-full max-w-md rounded-2xl border border-border bg-card p-6 space-y-5 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (nameOk) create.mutate({ name, persona: persona.trim() || undefined, templateId: templateId || undefined });
          }}
        >
          <div className="text-center space-y-2">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-foreground text-background flex items-center justify-center" aria-hidden="true">
              <Plus className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-medium tracking-tight text-foreground">New agent</h2>
            <p className="text-xs text-muted-foreground">
              the gateway scaffolds it from the template; it shows up in the sidebar shortly.
            </p>
          </div>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Name</span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="e.g. scout"
              className="mt-1.5 font-mono text-base sm:text-sm"
              autoFocus
            />
            <span className="text-[10px] text-muted-foreground/70">lowercase letter, then letters / digits / hyphens</span>
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
              Function <span className="text-muted-foreground/60 normal-case">(optional)</span>
            </span>
            <Input
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder="leave blank — the agent will figure it out from its name"
              className="mt-1.5 text-base sm:text-sm"
            />
          </label>
          {(templates.data?.length ?? 0) > 0 && (
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Template <span className="text-muted-foreground/60 normal-case">(optional)</span>
              </span>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="mt-1.5 w-full h-10 sm:h-9 rounded-md border border-border bg-background px-2 text-base sm:text-sm cursor-pointer"
              >
                <option value="">Built-in (default)</option>
                {(templates.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>{t.displayName} · v{t.latestVersion}</option>
                ))}
              </select>
              <span className="text-[10px] text-muted-foreground/70">从市场模板新建会套用它的 identity / 工作区规则 / skills</span>
            </label>
          )}
          {create.error && <p className="text-xs text-rose-500">{create.error.message}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={!nameOk || create.isPending} className="flex-1 h-10">
              {create.isPending ? 'queuing…' : 'Create agent'}
            </Button>
            <Button type="button" variant="ghost" className="h-10" onClick={onClose}>cancel</Button>
          </div>
        </form>
  );
}

function ImportAgentForm({ onClose }: { onClose: () => void }) {
  const [directory, setDirectory] = useState('');
  const router = useRouter();
  const utils = trpc.useUtils();
  const importMut = trpc.agents.requestImport.useMutation({
    onSuccess: () => {
      utils.agents.list.invalidate();
      // After import lands the row will show in the sidebar — bounce to /agents
      // so the default-redirect picks the freshly-imported one (or first agent).
      router.replace('/agents');
    },
  });
  const trimmed = directory.trim();
  const valid = trimmed.startsWith('/') && trimmed.length >= 2 && trimmed.length <= 4096;

  const previewName = (() => {
    if (!trimmed) return '';
    const raw = trimmed.replace(/\/+$/, '').split('/').pop() || '';
    return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31);
  })();
  const previewOk = /^[a-z][a-z0-9-]{0,30}$/.test(previewName);

  return (
        <form
          className="w-full max-w-md rounded-2xl border border-border bg-card p-6 space-y-5 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && previewOk) importMut.mutate({ directory: trimmed });
          }}
        >
          <div className="text-center space-y-2">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-foreground text-background flex items-center justify-center" aria-hidden="true">
              <FolderPlus className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-medium tracking-tight text-foreground">Import existing agent</h2>
            <p className="text-xs text-muted-foreground">
              Register a folder on the gateway host as an agent. Its path is stored in the DB; your folder stays put.
            </p>
          </div>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Directory</span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <Input
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="/Users/you/some-agent"
              className="mt-1.5 font-mono text-base sm:text-sm"
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <span className="text-[10px] text-muted-foreground/70">
              absolute path on the gateway host. must contain <code className="font-mono">CLAUDE.md</code> at its root.
            </span>
          </label>
          {trimmed && previewOk && (
            <div className="text-[11px] text-muted-foreground">
              will appear as <span className="font-mono text-foreground">{previewName}</span>
            </div>
          )}
          {trimmed && !previewOk && (
            <div className="text-[11px] text-amber-600">
              basename <span className="font-mono">{previewName || '(empty)'}</span> isn&apos;t a valid agent name — pick a folder whose name starts with a letter and uses letters/digits/hyphens.
            </div>
          )}
          {importMut.error && <p className="text-xs text-rose-500">{importMut.error.message}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={!valid || !previewOk || importMut.isPending} className="flex-1 h-10">
              {importMut.isPending ? 'queuing…' : 'Import'}
            </Button>
            <Button type="button" variant="ghost" className="h-10" onClick={onClose}>cancel</Button>
          </div>
        </form>
  );
}
