'use client';

// File manager for this machine's ~/.claude/global-memory folder — the same
// two-pane explorer as the agent "Files" tab (lazy tree left, inline content
// right), but pointed at the global-memory root (globalMemory:true) and with
// in-browser AUTHORING: New file + edit/save text (the folder is for writing
// memory notes, not uploading binaries — so no upload button here). Every text
// file dropped here is referenced into ~/.claude/CLAUDE.md as an @import by the
// gateway, so all agents on this machine load it. The inline note (the CLAUDE.md
// managed block) rides along as the explorer's first entry.

import { useMemo, useState } from 'react';
import { FolderPlus, FilePlus, RotateCw, Loader2, X, Check, Save, NotebookText } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { type Selected, joinPath, parentOf } from '@/components/file-explorer/core';
import { FileTree } from '@/components/file-explorer/file-tree';
import { FilePane } from '@/components/file-explorer/file-pane';

export function GlobalMemoryFiles() {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<Selected>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // The freshly-created file auto-opens in edit mode (so you can start typing).
  const [autoEditPath, setAutoEditPath] = useState<string | null>(null);
  // The inline note is the tree's first entry (the CLAUDE.md managed block, not a
  // folder file). Open by default — it's the thing people edit most. Selecting a
  // real file closes it; clicking the note row reopens it.
  const [noteOpen, setNoteOpen] = useState(true);
  // Stable across renders (see file-pane.tsx ImagePreview effect).
  const source = useMemo(() => ({ kind: 'globalMemory' as const }), []);

  const toggleExpand = (path: string, force?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const open = force ?? !next.has(path);
      if (open) next.add(path); else next.delete(path);
      return next;
    });

  // Selecting a real file (or folder) takes over the right pane from the note.
  const selectFile = (s: Selected) => { setSelected(s); setNoteOpen(false); };
  const openNote = () => { setNoteOpen(true); setSelected(null); };

  // New file / new folder target: the selected folder, the parent of the selected
  // file, else the folder root.
  const activeDir = selected ? (selected.type === 'dir' ? selected.path : parentOf(selected.path)) : '';

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      {error && (
        <div className="shrink-0 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-500">
          <span className="flex-1 break-words">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* One card: a toolbar header strip + the two-pane explorer body. */}
      <div className="flex flex-1 min-h-[320px] flex-col overflow-hidden rounded-lg border border-border">
        <Toolbar
          activeDir={activeDir}
          onError={setError}
          onMkdir={(p) => toggleExpand(p, true)}
          onCreated={(path, name) => { selectFile({ path, name, type: 'file', size: 0 }); setAutoEditPath(path); }}
          onRefresh={() => utils.fileManager.list.invalidate()}
        />

        <div className="flex flex-1 min-h-0">
          {/* Left: the inline note (pinned first) + the lazy file tree */}
          <div className="w-2/5 min-w-[150px] max-w-[320px] shrink-0 border-r border-border overflow-y-auto bg-muted/20">
            <div className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/60">Note &amp; files</div>
            <button
              type="button"
              onClick={openNote}
              style={{ paddingLeft: 8 }}
              className={cn(
                'flex w-full items-center gap-1 pr-1.5 h-7 cursor-pointer text-sm select-none',
                noteOpen ? 'bg-accent text-foreground' : 'hover:bg-accent/40 text-foreground/85',
              )}
            >
              <span className="w-3.5 shrink-0" />
              <NotebookText className="h-4 w-4 shrink-0 text-amber-500" />
              <span className="truncate flex-1 text-left">Inline note</span>
            </button>
            <FileTree
              source={source} path="" depth={0}
              expanded={expanded} toggleExpand={toggleExpand}
              selectedPath={noteOpen ? null : (selected?.path ?? null)} onSelect={selectFile} onError={setError}
              emptyLabel="Empty — use “New file” above to start"
            />
          </div>
          {/* Right: the note editor, or the selected file content / editor (inline) */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {noteOpen ? (
              <NotePane />
            ) : (
              <FilePane
                key={selected?.path ?? '∅'}
                source={source} selected={selected} capabilities={{ authoring: true }}
                autoEdit={!!selected && selected.path === autoEditPath}
                onSelect={setSelected} onError={setError}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The inline note, shown as the explorer's first "file" ────────────────────
// Persists to the DB-backed CLAUDE.md managed block (globalMemory.get/set), not
// the folder — so it stays a managed block (no gateway change) while living in
// the same explorer as the @import files.
function NotePane() {
  const utils = trpc.useUtils();
  const q = trpc.globalMemory.get.useQuery();
  const [draft, setDraft] = useState<string | null>(null);
  const save = trpc.globalMemory.set.useMutation({
    onSuccess: () => utils.globalMemory.get.invalidate(),
  });

  const serverContent = q.data?.content ?? '';
  const value = draft ?? serverContent;
  const dirty = draft !== null && draft !== serverContent;

  return (
    <>
      <div className="flex items-center gap-2 px-3 h-11 border-b border-border shrink-0">
        <NotebookText className="h-4 w-4 shrink-0 text-amber-500" />
        <span className="font-mono text-sm truncate flex-1">Inline note</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">CLAUDE.md block</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="flex h-full flex-col gap-2 p-3">
          <textarea
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            disabled={q.isPending}
            spellCheck={false}
            placeholder="A global note every agent loads (Markdown). e.g. shared preferences, naming conventions, current focus…"
            className="min-h-[220px] w-full flex-1 resize-none rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-foreground/30"
          />
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate({ content: value })}>
              {save.isPending ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Saving…</> : <><Save className="h-3.5 w-3.5 mr-1" /> Save</>}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {save.isError ? (
                <span className="text-rose-500">{save.error.message}</span>
              ) : dirty ? (
                'Unsaved changes'
              ) : q.data?.updatedAt ? (
                `Saved · ${relTime(q.data.updatedAt)}`
              ) : (
                'Not set yet'
              )}
            </span>
            <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/60">{value.length} chars</span>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Toolbar: new file + new folder, targeting the active directory ───────────
// Rendered as the explorer card's header strip.
function Toolbar({
  activeDir, onError, onMkdir, onCreated, onRefresh,
}: {
  activeDir: string;
  onError: (e: string | null) => void;
  onMkdir: (path: string) => void;
  onCreated: (path: string, name: string) => void;
  onRefresh: () => void;
}) {
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<'none' | 'file' | 'folder'>('none');
  const [name, setName] = useState('');

  const mkdir = trpc.fileManager.mkdir.useMutation({
    onSuccess: () => { utils.fileManager.list.invalidate(); onMkdir(activeDir); close(); },
    onError: (e) => onError(e.message),
  });
  const writeText = trpc.fileManager.writeText.useMutation({
    onSuccess: (_d, vars) => {
      utils.fileManager.list.invalidate();
      const nm = vars.path.split('/').pop() || vars.path;
      onCreated(vars.path, nm);
      close();
    },
    onError: (e) => onError(e.message),
  });

  function close() { setMode('none'); setName(''); }
  function submit() {
    const nm = name.trim();
    if (!nm) return;
    onError(null);
    if (mode === 'folder') mkdir.mutate({ globalMemory: true, path: joinPath(activeDir, nm) });
    else writeText.mutate({ globalMemory: true, path: joinPath(activeDir, nm), text: '' });
  }

  return (
    <div className="shrink-0 space-y-1.5 border-b border-border bg-muted/30 px-2 py-2">
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={() => { setMode('file'); setName(''); }}>
          <FilePlus className="h-3.5 w-3.5 mr-1" /> New file
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setMode('folder'); setName(''); }}>
          <FolderPlus className="h-3.5 w-3.5 mr-1" /> New folder
        </Button>
        <span className="text-[11px] text-muted-foreground/70 font-mono truncate min-w-0">→ {activeDir || 'global-memory'}</span>
        <Button size="icon-sm" variant="ghost" onClick={onRefresh} title="Refresh" className="ml-auto shrink-0">
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {mode !== 'none' && (
        <div className="flex items-center gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(); }}
            placeholder={mode === 'file' ? `New file in ${activeDir || 'global-memory'} (e.g. note.md)` : `New folder in ${activeDir || 'global-memory'}`}
            autoFocus
            className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-foreground/30"
          />
          <Button size="icon-sm" variant="ghost" disabled={!name.trim() || mkdir.isPending || writeText.isPending} onClick={submit}><Check className="h-3.5 w-3.5" /></Button>
          <Button size="icon-sm" variant="ghost" onClick={close}><X className="h-3.5 w-3.5" /></Button>
        </div>
      )}
    </div>
  );
}
