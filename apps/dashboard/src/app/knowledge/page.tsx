'use client';

// Knowledge — the per-machine library of knowledge bases. Each KB holds markdown
// documents and gets attached to agents from their detail view (like skills), where
// the gateway materializes it as a Claude Code skill for progressive loading.

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { BookOpen, Plus, FileText, Users } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SidebarMobileToggle } from '@/components/app-sidebar';

function goToBase(slug: string) {
  window.location.href = `/knowledge/${encodeURIComponent(slug)}`;
}

function NewBaseForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const params = useSearchParams();
  const create = trpc.knowledge.createBase.useMutation({ onSuccess: (r) => goToBase(r.slug) });

  useEffect(() => {
    if (params.get('new') === '1') setOpen(true);
  }, [params]);

  const submit = () => {
    const n = name.trim();
    if (n) create.mutate({ name: n });
  };

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-1" /> New knowledge base
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') { setOpen(false); setName(''); }
        }}
        placeholder="Knowledge base name"
        className="h-8 w-56 text-sm"
      />
      <Button size="sm" disabled={!name.trim() || create.isPending} onClick={submit}>
        Create
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setName(''); }}>
        Cancel
      </Button>
    </div>
  );
}

function KnowledgeList() {
  const bases = trpc.knowledge.listBases.useQuery();
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="h-12 px-3 sm:px-4 flex items-center justify-between gap-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <SidebarMobileToggle />
          <span className="text-sm font-semibold text-foreground">Knowledge</span>
        </div>
        <NewBaseForm />
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto p-4 sm:p-6">
          {bases.isLoading && <div className="text-xs text-muted-foreground">loading…</div>}
          {!bases.isLoading && (bases.data?.length ?? 0) === 0 && (
            <div className="text-sm text-muted-foreground">
              No knowledge bases yet. Create one, add markdown documents, then attach it to an agent
              from the agent&apos;s detail view — the agent loads only the intro and reads the docs on demand.
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {(bases.data ?? []).map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => goToBase(b.slug)}
                className="text-left rounded-lg border border-border bg-card hover:bg-accent/40 transition-colors p-3.5 cursor-pointer"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium truncate">{b.name}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground line-clamp-2 min-h-[2rem]">
                  {b.intro || 'No intro yet.'}
                </p>
                <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground/70">
                  <span className="inline-flex items-center gap-1">
                    <FileText className="h-3 w-3" /> {b.docCount} doc{b.docCount === 1 ? '' : 's'}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3 w-3" /> {b.attachedAgentCount} agent{b.attachedAgentCount === 1 ? '' : 's'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function KnowledgePage() {
  return (
    <Suspense fallback={null}>
      <KnowledgeList />
    </Suspense>
  );
}
