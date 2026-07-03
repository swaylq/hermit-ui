'use client';

// The knowledge-base editor: name + intro (Auto = maintained by the Brain's dream,
// Manual = you own it) on top, then the document list. Documents open in a MODAL to
// view/edit their markdown. Every save re-materializes the KB for attached agents.

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Plus, Trash2, ChevronUp, ChevronDown, Sparkles, Pencil, FileText, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Overlay } from '@/components/overlay';
import { SidebarMobileToggle } from '@/components/app-sidebar';

type Doc = { id: string; title: string; filename: string; sortOrder: number };

export default function KnowledgeBaseEditorPage() {
  const params = useParams<{ slug: string }>();
  // Key by slug so switching bases in the sidebar remounts the editor cleanly —
  // no stale draft state carried from the previously-open base.
  return <KnowledgeBaseEditor key={params.slug} slug={params.slug} />;
}

function KnowledgeBaseEditor({ slug }: { slug: string }) {
  const utils = trpc.useUtils();
  const base = trpc.knowledge.getBase.useQuery({ slug });
  const refresh = () => utils.knowledge.getBase.invalidate({ slug });

  // null = closed; { docId: null } = new document; { docId } = edit that document.
  const [modalDoc, setModalDoc] = useState<{ docId: string | null } | null>(null);
  const docs: Doc[] = base.data?.docs ?? [];

  if (base.isLoading) {
    return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">loading…</div>;
  }
  if (!base.data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <div>Knowledge base not found.</div>
        <a href="/knowledge" className="text-primary underline">← Back to Knowledge</a>
      </div>
    );
  }
  const kb = base.data;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="h-12 px-3 sm:px-4 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <NameEditor id={kb.id} name={kb.name} onSaved={refresh} />
        <div className="flex-1" />
        <DeleteBaseButton id={kb.id} name={kb.name} />
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto p-4 sm:p-6 space-y-5">
          <IntroEditor id={kb.id} intro={kb.intro} autoIntro={kb.autoIntro} onSaved={refresh} />
          <DocsSection
            baseId={kb.id}
            docs={docs}
            onOpen={(docId) => setModalDoc({ docId })}
            onNew={() => setModalDoc({ docId: null })}
            onChanged={refresh}
          />
        </div>
      </div>

      {modalDoc && (
        <DocModal
          baseId={kb.id}
          docId={modalDoc.docId}
          onClose={() => setModalDoc(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function NameEditor({ id, name, onSaved }: { id: string; name: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  useEffect(() => setVal(name), [name]);
  const update = trpc.knowledge.updateBase.useMutation({ onSuccess: () => { setEditing(false); onSaved(); } });
  const save = () => {
    const n = val.trim();
    if (n && n !== name) update.mutate({ id, name: n });
    else setEditing(false);
  };
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Rename"
        className="group inline-flex items-center gap-1.5 min-w-0 rounded px-1 py-0.5 hover:bg-accent cursor-pointer"
      >
        <span className="text-sm font-semibold truncate">{name}</span>
        <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
      </button>
    );
  }
  return (
    <Input
      autoFocus
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') { setVal(name); setEditing(false); }
      }}
      onBlur={save}
      className="h-7 w-64 text-sm font-semibold"
    />
  );
}

function DeleteBaseButton({ id, name }: { id: string; name: string }) {
  const confirm = useConfirm();
  const del = trpc.knowledge.deleteBase.useMutation({ onSuccess: () => { window.location.href = '/knowledge'; } });
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-muted-foreground hover:text-rose-500"
      onClick={async () => {
        if (await confirm({ title: 'Delete knowledge base', message: `Delete "${name}" and all its documents? Attached agents will lose it.`, confirmLabel: 'Delete', danger: true })) {
          del.mutate({ id });
        }
      }}
      title="Delete knowledge base"
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

// Intro = the always-loaded summary. autoIntro on → the Brain rewrites it each dream;
// editing here switches it to Manual (server-side). A Manual base can switch back.
function IntroEditor({ id, intro, autoIntro, onSaved }: { id: string; intro: string; autoIntro: boolean; onSaved: () => void }) {
  const [val, setVal] = useState(intro);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setVal(intro); setDirty(false); }, [intro, autoIntro]);
  const update = trpc.knowledge.updateBase.useMutation({ onSuccess: onSaved });
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-foreground">Intro</label>
        <span
          className={
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] ' +
            (autoIntro ? 'border-violet-500/30 text-violet-500 bg-violet-500/10' : 'border-border text-muted-foreground')
          }
          title={autoIntro ? 'The Brain refreshes this from the documents during its daily dream.' : 'You maintain this text; the Brain leaves it alone.'}
        >
          {autoIntro ? <><Sparkles className="h-2.5 w-2.5" /> Auto</> : 'Manual'}
        </span>
        {!autoIntro && (
          <button
            type="button"
            onClick={() => update.mutate({ id, autoIntro: true })}
            className="text-[11px] text-primary hover:underline cursor-pointer"
          >
            switch to Auto
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        One or two sentences: what this knowledge base contains and when an agent should consult it. This is the only part always kept in the agent&apos;s context.
      </p>
      <Textarea
        value={val}
        onChange={(e) => { setVal(e.target.value); setDirty(true); }}
        rows={3}
        placeholder="e.g. Our REST API — endpoints, auth, rate limits. Consult before answering API questions."
        className="text-sm"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!dirty || update.isPending} onClick={() => update.mutate({ id, intro: val })}>
          Save intro
        </Button>
        {autoIntro && dirty && <span className="text-[11px] text-muted-foreground">Saving switches this base to Manual.</span>}
      </div>
    </section>
  );
}

// The document list. Rows open the editor MODAL (view/edit); reorder + delete live
// inline on hover. "New document" opens the modal in create mode.
function DocsSection({
  baseId, docs, onOpen, onNew, onChanged,
}: {
  baseId: string;
  docs: Doc[];
  onOpen: (docId: string) => void;
  onNew: () => void;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const del = trpc.knowledge.deleteDoc.useMutation({ onSuccess: onChanged });
  const reorder = trpc.knowledge.reorderDocs.useMutation({ onSuccess: onChanged });

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= docs.length) return;
    const ids = docs.map((d) => d.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate({ baseId, orderedIds: ids });
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">Documents</span>
        <Button size="sm" variant="ghost" onClick={onNew}>
          <Plus className="h-3.5 w-3.5 mr-1" /> New document
        </Button>
      </div>
      {docs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
          No documents yet. Add one — the agent reads these on demand, only when relevant.
        </div>
      ) : (
        <div className="space-y-1">
          {docs.map((d, i) => (
            <div
              key={d.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(d.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(d.id); } }}
              className="group flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 cursor-pointer hover:bg-accent/40 transition-colors"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
              <span className="flex-1 truncate text-sm">{d.title}</span>
              {/* Reveal on hover (desktop) but ALWAYS visible on touch: an
                  opacity-0 control still captures taps, so on a hover-less device the
                  invisible reorder/delete buttons stole taps meant to open the doc —
                  the row reordered instead of opening the modal. */}
              <span className="flex items-center shrink-0 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                <button type="button" title="Move up" onClick={(e) => { e.stopPropagation(); move(i, -1); }} className="p-0.5 hover:text-foreground disabled:opacity-30 cursor-pointer" disabled={i === 0}>
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button type="button" title="Move down" onClick={(e) => { e.stopPropagation(); move(i, 1); }} className="p-0.5 hover:text-foreground disabled:opacity-30 cursor-pointer" disabled={i === docs.length - 1}>
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="Delete document"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (await confirm({ title: 'Delete document', message: `Delete "${d.title}"?`, confirmLabel: 'Delete', danger: true })) del.mutate({ id: d.id });
                  }}
                  className="p-0.5 hover:text-rose-500 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Modal editor — create (docId=null) or edit an existing document. Backdrop/Esc are
// blocked while there are unsaved changes (interceptClose); Cancel/X discard.
function DocModal({
  baseId, docId, onClose, onChanged,
}: {
  baseId: string;
  docId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const isNew = docId == null;
  const doc = trpc.knowledge.docContent.useQuery({ docId: docId ?? '' }, { enabled: !isNew });
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!isNew && doc.data) { setTitle(doc.data.title); setContent(doc.data.content); setDirty(false); }
  }, [isNew, doc.data]);

  const create = trpc.knowledge.createDoc.useMutation();
  const update = trpc.knowledge.updateDoc.useMutation();
  const saving = create.isPending || update.isPending;
  const err = create.error?.message || update.error?.message;
  const loading = !isNew && doc.isLoading;
  const notFound = !isNew && !doc.isLoading && !doc.data;

  return (
    <Overlay
      onClose={onClose}
      interceptClose={() => dirty}
      panelClassName="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-xl border border-border bg-background shadow-2xl"
    >
      {(close) => {
        const save = () => {
          const t = title.trim();
          if (!t) return;
          const onSuccess = () => { setDirty(false); onChanged(); close(); };
          if (docId == null) create.mutate({ baseId, title: t, content }, { onSuccess });
          else update.mutate({ id: docId, title: t, content }, { onSuccess });
        };
        return (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5 shrink-0">
              <span className="text-sm font-medium">{isNew ? 'New document' : 'Edit document'}</span>
              <button type="button" onClick={close} aria-label="close" className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent cursor-pointer">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-4 space-y-2">
              {loading ? (
                <div className="text-xs text-muted-foreground">loading…</div>
              ) : notFound ? (
                <div className="text-xs text-muted-foreground">Document not found.</div>
              ) : (
                <>
                  <Input
                    autoFocus={isNew}
                    value={title}
                    onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
                    placeholder="Document title"
                    className="h-9 text-sm font-medium"
                  />
                  <Textarea
                    value={content}
                    onChange={(e) => { setContent(e.target.value); setDirty(true); }}
                    rows={18}
                    placeholder="Markdown content…"
                    className="text-sm font-mono leading-relaxed"
                  />
                </>
              )}
              {err && <div className="text-[11px] text-rose-500">{err}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5 shrink-0">
              {dirty && <span className="mr-auto text-[11px] text-muted-foreground">Unsaved changes</span>}
              <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
              <Button size="sm" disabled={loading || notFound || !title.trim() || saving} onClick={save}>
                {isNew ? 'Create' : 'Save'}
              </Button>
            </div>
          </>
        );
      }}
    </Overlay>
  );
}
