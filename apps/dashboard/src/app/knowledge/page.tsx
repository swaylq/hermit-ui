'use client';

// The right-hand detail pane for /knowledge with no base selected: an empty state
// + a create form. The list of bases is the sidebar (KnowledgeSidebarList in
// app-sidebar), so this route is the master-detail "nothing selected" placeholder —
// the same way /chat with no ?session shows a start-a-chat panel.

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { BookOpen, Plus, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SidebarMobileToggle } from '@/components/app-sidebar';

export default function KnowledgeIndexPage() {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="h-12 px-3 sm:px-4 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-semibold text-foreground">Knowledge</span>
      </header>
      <Suspense fallback={<div className="flex-1" />}>
        <EmptyPane />
      </Suspense>
    </div>
  );
}

function EmptyPane() {
  const params = useSearchParams();
  const router = useRouter();
  const bases = trpc.knowledge.listBases.useQuery();
  const first = bases.data?.[0];
  // ?new=1 (the sidebar CTA) opens the create form straight away.
  const [creating, setCreating] = useState(params.get('new') === '1');

  // Master-detail default: entering /knowledge with bases present opens the first
  // one — unless you're creating a new base. With none, the empty state shows.
  useEffect(() => {
    if (!creating && first) router.replace(`/knowledge/${encodeURIComponent(first.slug)}`);
  }, [creating, first, router]);

  // Don't flash the empty state before the redirect resolves (loading, or a base
  // exists and we're about to jump to it).
  if (!creating && (bases.isLoading || first)) return <div className="flex-1" />;

  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-6">
      {creating ? (
        <NewBaseForm onCancel={() => setCreating(false)} />
      ) : (
        <div className="flex flex-col items-center gap-3 text-center max-w-sm">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted text-muted-foreground">
            <BookOpen className="h-6 w-6" />
          </div>
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-foreground">Knowledge bases</h2>
            <p className="text-xs text-muted-foreground">
              Durable reference docs an agent loads as an always-on intro and reads on demand. Create one to get started.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1" /> New knowledge base
          </Button>
        </div>
      )}
    </div>
  );
}

function NewBaseForm({ onCancel }: { onCancel: () => void }) {
  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const create = trpc.knowledge.createBase.useMutation({
    onSuccess: (r) => { window.location.href = `/knowledge/${encodeURIComponent(r.slug)}`; },
  });
  const submit = () => {
    const n = name.trim();
    if (n) create.mutate({ name: n, intro: intro.trim() || undefined });
  };
  return (
    <div className="w-full max-w-sm space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">New knowledge base</h2>
        <button
          type="button"
          onClick={onCancel}
          aria-label="cancel"
          className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">Name</label>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder="e.g. Payments API"
          className="h-9"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">
          Intro <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <Textarea
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
          rows={3}
          placeholder="One or two sentences: what it holds + when to consult it. Leave empty to let the Brain summarize it from the docs."
          className="text-sm"
        />
      </div>
      {create.error && <div className="text-[11px] text-rose-500">{create.error.message}</div>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={!name.trim() || create.isPending} onClick={submit}>Create</Button>
      </div>
    </div>
  );
}
