'use client';

// The explorer's RIGHT pane, shared by both surfaces: the selected file/folder's
// header (rename / download / delete, + Edit when authoring) and body (inline text
// or image preview, a folder summary, or — when authoring — the text editor).
// Parametrized by `source` (agent dir vs global-memory) and `capabilities`
// (authoring = the global-memory folder's in-browser New file / edit-save). The
// lazy tree is ./file-tree; the shared helpers + download path are ./core.
//
// NOTE: `source` MUST be a STABLE reference (the parents memoize it) — ImagePreview's
// effect depends on it, so a fresh object literal each render would refetch forever.

import { useEffect, useState } from 'react';
import { Folder, File as FileIcon, Download, Trash2, Pencil, Loader2, X, Check, FileText, Save } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import {
  type FileSource, type Selected, srcInput, joinPath, parentOf,
  fmtSize, IMAGE_RE, PREVIEW_IMG_MAX, fetchPreparedBlob, pullDownload,
} from './core';

export type FileExplorerCapabilities = {
  // In-browser text authoring (edit + save existing files, and the empty-file Edit
  // prompt) — the global-memory folder. Off for an agent dir (read/download only).
  authoring?: boolean;
};

export function FilePane({
  source, selected, capabilities, autoEdit = false, onSelect, onError,
}: {
  source: FileSource; selected: Selected; capabilities?: FileExplorerCapabilities;
  autoEdit?: boolean; onSelect: (s: Selected) => void; onError: (e: string | null) => void;
}) {
  const authoring = !!capabilities?.authoring;
  const utils = trpc.useUtils();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [editing, setEditing] = useState(autoEdit);

  const remove = trpc.fileManager.remove.useMutation({
    onSuccess: () => { utils.fileManager.list.invalidate(); onSelect(null); },
    onError: (e) => onError(e.message),
  });
  const rename = trpc.fileManager.rename.useMutation({
    onSuccess: (_d, vars) => {
      utils.fileManager.list.invalidate();
      setRenaming(false);
      if (selected) onSelect({ ...selected, path: vars.toPath, name: vars.toPath.split('/').pop() || selected.name });
    },
    onError: (e) => onError(e.message),
  });
  const prepare = trpc.fileManager.prepareDownload.useMutation();

  if (!selected) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 text-muted-foreground">
        <FileText className="h-9 w-9 mb-2 opacity-25" />
        <p className="text-xs">
          {authoring
            ? 'Select a file on the left to view / edit, or create one to start writing.'
            : 'Select a file on the left to view it, or a folder to act on.'}
        </p>
      </div>
    );
  }

  const isDir = selected.type === 'dir';
  const isImg = IMAGE_RE.test(selected.name);

  async function doDownload() {
    if (!selected) return;
    onError(null);
    setDownloading(true);
    try {
      await pullDownload(source, selected.path, isDir, selected.name, utils, prepare.mutateAsync);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }
  async function doDelete() {
    if (!selected) return;
    if (!(await confirm({
      title: `Delete ${isDir ? 'folder' : 'file'}`,
      message: `Delete ${isDir ? 'folder' : 'file'} "${selected.name}"${isDir ? ' and all its contents' : ''}? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    remove.mutate({ ...srcInput(source), path: selected.path });
  }
  function commitRename() {
    if (!selected) return;
    const name = draft.trim();
    if (!name || name === selected.name) { setRenaming(false); return; }
    rename.mutate({ ...srcInput(source), path: selected.path, toPath: joinPath(parentOf(selected.path), name) });
  }

  return (
    <>
      {/* Header: name + actions */}
      <div className="flex items-center gap-2 px-3 h-11 border-b border-border shrink-0">
        {isDir ? <Folder className="h-4 w-4 shrink-0 text-sky-500" /> : <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
        {renaming ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false); }}
            autoFocus
            className="h-7 flex-1 min-w-0 rounded border border-border bg-background px-2 text-sm font-mono outline-none focus:border-foreground/30"
          />
        ) : (
          <span className="font-mono text-sm truncate flex-1" title={selected.path}>{selected.name}</span>
        )}
        {renaming ? (
          <>
            <button onClick={commitRename} className="p-1 text-muted-foreground hover:text-foreground" title="Save"><Check className="h-4 w-4" /></button>
            <button onClick={() => setRenaming(false)} className="p-1 text-muted-foreground hover:text-foreground" title="Cancel"><X className="h-4 w-4" /></button>
          </>
        ) : (
          <>
            {authoring && !isDir && !isImg && !editing && (
              <button onClick={() => setEditing(true)} className="p-1 text-muted-foreground hover:text-foreground" title="Edit"><Pencil className="h-4 w-4" /></button>
            )}
            <button onClick={doDownload} disabled={downloading} className="p-1 text-muted-foreground hover:text-foreground" title={isDir ? 'Download as zip' : 'Download'}>
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            </button>
            <button onClick={() => { setDraft(selected.name); setRenaming(true); }} className="p-1 text-muted-foreground hover:text-foreground" title="Rename"><Pencil className="h-4 w-4" /></button>
            <button onClick={doDelete} disabled={remove.isPending} className="p-1 text-muted-foreground hover:text-rose-500" title="Delete">
              {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          </>
        )}
      </div>

      {/* Body: editor (authoring) / inline content / folder summary */}
      <div className="flex-1 min-h-0 overflow-auto">
        {isDir ? (
          <div className="p-4 text-xs text-muted-foreground space-y-1">
            <p className="font-mono text-foreground/70 break-all">{selected.path || '(root)'}</p>
            <p>Folder — expand it on the left, or use the buttons above to download as zip / rename / delete.</p>
          </div>
        ) : authoring && editing && !isImg ? (
          <FileEditor source={source} path={selected.path} onError={onError} onDone={() => setEditing(false)} />
        ) : (
          <FileContent
            source={source} path={selected.path} size={selected.size} isImg={isImg}
            onDownload={doDownload} downloading={downloading}
            onEdit={authoring ? () => setEditing(true) : undefined}
          />
        )}
      </div>
    </>
  );
}

function DownloadBtn({ onDownload, downloading }: { onDownload: () => void; downloading: boolean }) {
  return (
    <Button size="sm" variant="outline" onClick={onDownload} disabled={downloading}>
      {downloading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />} Download file
    </Button>
  );
}

// Editor — load current text, edit, save (writeText). New + existing files. Only
// mounted when authoring is on (global-memory), hence the CLAUDE.md-specific hint.
function FileEditor({ source, path, onError, onDone }: { source: FileSource; path: string; onError: (e: string | null) => void; onDone: () => void }) {
  const utils = trpc.useUtils();
  const q = trpc.fileManager.readText.useQuery({ ...srcInput(source), path }, { retry: false });
  const [draft, setDraft] = useState<string | null>(null);
  const save = trpc.fileManager.writeText.useMutation({
    onSuccess: () => { utils.fileManager.readText.invalidate({ ...srcInput(source), path }); utils.fileManager.list.invalidate(); onDone(); },
    onError: (e) => onError(e.message),
  });

  // A brand-new file readText-errors (or returns empty); treat any load failure as
  // a blank canvas so you can still write.
  const serverText = q.data?.text ?? '';
  const value = draft ?? serverText;

  return (
    <div className="flex flex-col h-full p-3 gap-2">
      <textarea
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        disabled={q.isPending}
        spellCheck={false}
        autoFocus
        placeholder="Write content here (Markdown). Referenced by this machine’s ~/.claude/CLAUDE.md within ~30s of saving."
        className="flex-1 min-h-[200px] w-full rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-foreground/30 resize-none"
      />
      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ ...srcInput(source), path, text: value })}>
          {save.isPending ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Saving…</> : <><Save className="h-3.5 w-3.5 mr-1" /> Save</>}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/60">{value.length} chars</span>
      </div>
    </div>
  );
}

// Inline view (no modal): images render as <img>, text shows a preview; binary /
// oversized falls back to a download button. `onEdit` (authoring only) turns the
// empty-file state into an Edit prompt.
function FileContent({
  source, path, size, isImg, onDownload, downloading, onEdit,
}: {
  source: FileSource; path: string; size: number; isImg: boolean;
  onDownload: () => void; downloading: boolean; onEdit?: () => void;
}) {
  return (
    <div className="p-3">
      <div className="mb-2 text-[11px] font-mono text-muted-foreground/60">{fmtSize(size)}</div>
      {isImg ? (
        size > PREVIEW_IMG_MAX ? (
          <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
            <p>Large image ({fmtSize(size)}) — not previewed automatically.</p>
            <DownloadBtn onDownload={onDownload} downloading={downloading} />
          </div>
        ) : (
          <ImagePreview key={path} source={source} path={path} onDownload={onDownload} downloading={downloading} />
        )
      ) : (
        <TextPreview source={source} path={path} onDownload={onDownload} downloading={downloading} onEdit={onEdit} />
      )}
    </div>
  );
}

function TextPreview({
  source, path, onDownload, downloading, onEdit,
}: {
  source: FileSource; path: string; onDownload: () => void; downloading: boolean; onEdit?: () => void;
}) {
  const q = trpc.fileManager.readText.useQuery({ ...srcInput(source), path }, { retry: false });
  if (q.isPending) return <div className="h-40 rounded bg-accent/30 animate-pulse" />;
  if (q.error) {
    return (
      <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
        <p>{q.error.message}</p>
        <DownloadBtn onDownload={onDownload} downloading={downloading} />
      </div>
    );
  }
  // Authoring surfaces turn an empty file into an Edit prompt; read-only ones just
  // show the (empty) preview.
  if (onEdit && !q.data?.text) {
    return (
      <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
        <p>Empty file.</p>
        <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="h-3.5 w-3.5 mr-1" /> Edit</Button>
      </div>
    );
  }
  return <pre className="text-[12px] font-mono whitespace-pre-wrap break-words text-foreground/90 leading-relaxed">{q.data?.text}</pre>;
}

// Image preview — pull the bytes via the prepared-download path (gateway → stash →
// blob), render as an object URL. Keyed by path so it refetches cleanly on file
// change; the object URL is revoked on unmount. `source` must be stable (see top).
function ImagePreview({
  source, path, onDownload, downloading,
}: {
  source: FileSource; path: string; onDownload: () => void; downloading: boolean;
}) {
  const utils = trpc.useUtils();
  const prepareAsync = trpc.fileManager.prepareDownload.useMutation().mutateAsync;
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    let objUrl: string | undefined;
    void (async () => {
      try {
        const { blob } = await fetchPreparedBlob(source, path, false, utils, prepareAsync);
        if (cancelled) return;
        objUrl = URL.createObjectURL(blob);
        setState({ url: objUrl });
      } catch (e) {
        if (!cancelled) setState({ error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [source, path, utils, prepareAsync]);

  if (state.error) {
    return (
      <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
        <p>Preview failed: {state.error}</p>
        <DownloadBtn onDownload={onDownload} downloading={downloading} />
      </div>
    );
  }
  if (!state.url) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading preview…
      </div>
    );
  }
  return (
    <div className="flex justify-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={state.url} alt={path.split('/').pop() ?? ''} className="max-w-full max-h-[60vh] w-auto h-auto rounded border border-border object-contain" />
    </div>
  );
}
