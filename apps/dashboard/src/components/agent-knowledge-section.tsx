'use client';

// The agent-detail "Knowledge bases" section (sits next to Skills): the KBs attached
// to this agent, with attach/detach. Attaching enqueues a materialize so the gateway
// writes <agent>/.claude/skills/kb-<slug>/ — the agent then loads the intro and reads
// docs on demand. Content is authored in the /knowledge library, not here.

import { useState } from 'react';
import { BookOpen, Plus, X, Check } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Overlay } from '@/components/overlay';
import { useConfirm } from '@/components/ui/confirm-dialog';

export function AgentKnowledgeSection({ agentName }: { agentName: string }) {
  const utils = trpc.useUtils();
  const confirm = useConfirm();
  const attached = trpc.knowledge.listAgentBases.useQuery({ agentName });
  const [picking, setPicking] = useState(false);
  const detach = trpc.knowledge.detachFromAgent.useMutation({
    onSuccess: () => utils.knowledge.listAgentBases.invalidate({ agentName }),
  });
  const list = attached.data ?? [];

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Knowledge bases</h3>
        <Button size="sm" variant="ghost" onClick={() => setPicking(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Attach
        </Button>
      </div>
      {attached.isLoading && <div className="text-xs text-muted-foreground">loading…</div>}
      {!attached.isLoading && list.length === 0 && (
        <div className="text-xs text-muted-foreground">
          No knowledge bases attached. Attach one so this agent loads its intro and reads its docs on demand.
        </div>
      )}
      <div className="space-y-1.5">
        {list.map((kb) => (
          <div key={kb.id} className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
            <a href={`/knowledge/${encodeURIComponent(kb.slug)}`} className="min-w-0 group">
              <div className="flex items-center gap-1.5 min-w-0">
                <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium truncate group-hover:underline">{kb.name}</span>
                <span className="text-[10px] text-muted-foreground/70 shrink-0">
                  {kb.docCount} doc{kb.docCount === 1 ? '' : 's'}
                </span>
              </div>
              {kb.intro && <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">{kb.intro}</p>}
            </a>
            <button
              type="button"
              title="Detach"
              onClick={async () => {
                if (await confirm({ title: 'Detach knowledge base', message: `Detach "${kb.name}" from ${agentName}? The content stays in the library.`, confirmLabel: 'Detach' })) {
                  detach.mutate({ agentName, baseId: kb.id });
                }
              }}
              className="shrink-0 p-1 text-muted-foreground hover:text-rose-500 cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      {picking && (
        <AttachKnowledgeDialog agentName={agentName} attachedIds={new Set(list.map((k) => k.id))} onClose={() => setPicking(false)} />
      )}
    </section>
  );
}

function AttachKnowledgeDialog({
  agentName, attachedIds, onClose,
}: {
  agentName: string;
  attachedIds: Set<string>;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const bases = trpc.knowledge.listBases.useQuery();
  const [doneId, setDoneId] = useState<string | null>(null);
  const attach = trpc.knowledge.attachToAgent.useMutation({
    onSuccess: (_r, vars) => {
      utils.knowledge.listAgentBases.invalidate({ agentName });
      setDoneId(vars.baseId);
    },
  });
  const list = bases.data ?? [];

  return (
    <Overlay onClose={onClose} panelClassName="w-full max-w-lg max-h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl">
      {(close) => (
        <>
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 shrink-0">
            <span className="text-sm font-medium">Attach knowledge base → {agentName}</span>
            <button type="button" onClick={close} aria-label="close" className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent cursor-pointer">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-3 space-y-1.5">
            {bases.isLoading && <div className="text-xs text-muted-foreground">loading…</div>}
            {!bases.isLoading && list.length === 0 && (
              <div className="text-xs text-muted-foreground">No knowledge bases on this machine yet. Create one under Knowledge first.</div>
            )}
            {list.map((b) => {
              const already = attachedIds.has(b.id) || doneId === b.id;
              return (
                <div key={b.id} className="flex items-center justify-between gap-2 rounded border bg-card px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{b.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {b.intro || `${b.docCount} doc${b.docCount === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <Button size="sm" variant={already ? 'ghost' : undefined} disabled={already || attach.isPending} onClick={() => attach.mutate({ agentName, baseId: b.id })}>
                    {already ? <><Check className="h-3.5 w-3.5 mr-1" /> attached</> : 'attach'}
                  </Button>
                </div>
              );
            })}
            {attach.error && <div className="text-[11px] text-rose-500">{attach.error.message}</div>}
          </div>
        </>
      )}
    </Overlay>
  );
}
