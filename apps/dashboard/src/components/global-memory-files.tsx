'use client';

// File manager for this machine's ~/.claude/global-memory folder — the same
// two-pane explorer as the agent "Files" tab (lazy tree left, inline content
// right), but pointed at the global-memory root (globalMemory:true) and with
// in-browser AUTHORING: New file + edit/save text (the folder is for writing
// memory notes, not uploading binaries — so no upload button here). Every text
// file dropped here is referenced into ~/.claude/CLAUDE.md as an @import by the
// gateway, so all agents on this machine load it.

import { useEffect, useState } from 'react';
import {
  Folder, FolderOpen, File as FileIcon, Download, Trash2, Pencil,
  FolderPlus, FilePlus, ChevronRight, RotateCw, Loader2, X, Check, FileText, Save,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { getActiveKey } from '@/lib/keyring';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const PREVIEW_IMG_MAX = 25 * 1024 * 1024;

type Entry = { name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number };
type Selected = { path: string; name: string; type: 'dir' | 'file' | 'other'; size: number } | null;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const joinPath = (base: string, name: string) => (base ? `${base}/${name}` : name);
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch a prepared download (file, or gateway-zipped folder) as a Blob.
async function fetchPreparedBlob(
  path: string,
  isFolder: boolean,
  utils: ReturnType<typeof trpc.useUtils>,
  prepareAsync: (v: { globalMemory: boolean; path: string; isFolder: boolean }) => Promise<{ id: string }>,
): Promise<{ blob: Blob; filename: string }> {
  const { id } = await prepareAsync({ globalMemory: true, path, isFolder });
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const s = await utils.fileManager.downloadStatus.fetch({ id });
    if (s.status === 'ready') {
      const res = await fetch(`/api/file-manager/download/${encodeURIComponent(id)}`, { headers: { 'x-asst-key': getActiveKey() } });
      if (!res.ok) throw new Error(`加载失败 (${res.status})`);
      return { blob: await res.blob(), filename: s.filename };
    }
    if (s.status === 'error') throw new Error(s.error || '准备失败');
  }
  throw new Error('超时');
}

async function pullDownload(
  path: string,
  isFolder: boolean,
  fallbackName: string,
  utils: ReturnType<typeof trpc.useUtils>,
  prepareAsync: (v: { globalMemory: boolean; path: string; isFolder: boolean }) => Promise<{ id: string }>,
): Promise<void> {
  const { blob, filename } = await fetchPreparedBlob(path, isFolder, utils, prepareAsync);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function GlobalMemoryFiles() {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<Selected>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // The freshly-created file auto-opens in edit mode (so you can start typing).
  const [autoEditPath, setAutoEditPath] = useState<string | null>(null);

  const toggleExpand = (path: string, force?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const open = force ?? !next.has(path);
      if (open) next.add(path); else next.delete(path);
      return next;
    });

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

      <Toolbar
        activeDir={activeDir}
        onError={setError}
        onMkdir={(p) => toggleExpand(p, true)}
        onCreated={(path, name) => { setSelected({ path, name, type: 'file', size: 0 }); setAutoEditPath(path); }}
        onRefresh={() => utils.fileManager.list.invalidate()}
      />

      <div className="flex flex-1 min-h-[300px] rounded-lg border border-border overflow-hidden">
        {/* Left: lazy file tree */}
        <div className="w-2/5 min-w-[150px] max-w-[320px] shrink-0 border-r border-border overflow-y-auto bg-muted/20">
          <TreeChildren
            path="" depth={0}
            expanded={expanded} toggleExpand={toggleExpand}
            selectedPath={selected?.path ?? null} onSelect={setSelected} onError={setError}
          />
        </div>
        {/* Right: selected file content / editor (inline, no modal) */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <FilePane
            key={selected?.path ?? '∅'}
            selected={selected} autoEdit={!!selected && selected.path === autoEditPath}
            onSelect={setSelected} onError={setError}
          />
        </div>
      </div>
    </div>
  );
}

// ── Toolbar: new file + new folder, targeting the active directory ───────────
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
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={() => { setMode('file'); setName(''); }}>
          <FilePlus className="h-3.5 w-3.5 mr-1" /> 新建文件
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setMode('folder'); setName(''); }}>
          <FolderPlus className="h-3.5 w-3.5 mr-1" /> 新建文件夹
        </Button>
        <span className="text-[11px] text-muted-foreground/70 font-mono truncate min-w-0">→ {activeDir || 'global-memory'}</span>
        <Button size="icon-sm" variant="ghost" onClick={onRefresh} title="刷新" className="ml-auto shrink-0">
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {mode !== 'none' && (
        <div className="flex items-center gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(); }}
            placeholder={mode === 'file' ? `在 ${activeDir || 'global-memory'} 下新建文件（如 note.md）` : `在 ${activeDir || 'global-memory'} 下新建文件夹`}
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

// ── Tree: the lazily-loaded children of one directory ────────────────────────
function TreeChildren({
  path, depth, expanded, toggleExpand, selectedPath, onSelect, onError,
}: {
  path: string; depth: number;
  expanded: Set<string>; toggleExpand: (p: string, force?: boolean) => void;
  selectedPath: string | null; onSelect: (s: Selected) => void; onError: (e: string | null) => void;
}) {
  const list = trpc.fileManager.list.useQuery({ globalMemory: true, path }, { retry: false });
  const indent = depth * 12 + 8;

  if (list.isPending) {
    return <div style={{ paddingLeft: indent + 16 }} className="py-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /></div>;
  }
  if (list.error) {
    return <div style={{ paddingLeft: indent + 16 }} className="py-1 text-[11px] text-rose-500 pr-2 break-words">{list.error.message}</div>;
  }
  const entries = (list.data?.entries ?? []) as Entry[];
  if (entries.length === 0) {
    return <div style={{ paddingLeft: indent + 16 }} className="py-1 text-[11px] text-muted-foreground/50">空 — 用上方「新建文件」开始</div>;
  }
  return (
    <ul>
      {entries.map((e) => (
        <TreeNode
          key={e.name}
          entry={e} path={joinPath(path, e.name)} depth={depth}
          expanded={expanded} toggleExpand={toggleExpand} selectedPath={selectedPath} onSelect={onSelect} onError={onError}
        />
      ))}
      {list.data?.truncated && (
        <li style={{ paddingLeft: indent + 16 }} className="py-1 text-[11px] text-amber-600">…目录过大，已截断</li>
      )}
    </ul>
  );
}

function TreeNode({
  entry, path, depth, expanded, toggleExpand, selectedPath, onSelect, onError,
}: {
  entry: Entry; path: string; depth: number;
  expanded: Set<string>; toggleExpand: (p: string, force?: boolean) => void;
  selectedPath: string | null; onSelect: (s: Selected) => void; onError: (e: string | null) => void;
}) {
  const isDir = entry.type === 'dir';
  const isOpen = expanded.has(path);
  const isSel = selectedPath === path;
  const indent = depth * 12 + 8;

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => { onSelect({ path, name: entry.name, type: entry.type, size: entry.size }); if (isDir) toggleExpand(path); }}
        style={{ paddingLeft: indent }}
        className={cn(
          'group flex items-center gap-1 pr-1.5 h-7 cursor-pointer text-sm select-none',
          isSel ? 'bg-accent text-foreground' : 'hover:bg-accent/40 text-foreground/85',
        )}
      >
        {isDir ? (
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {isDir ? (
          isOpen ? <FolderOpen className="h-4 w-4 shrink-0 text-sky-500" /> : <Folder className="h-4 w-4 shrink-0 text-sky-500" />
        ) : (
          <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate flex-1">{entry.name}</span>
      </div>
      {isDir && isOpen && (
        <TreeChildren
          path={path} depth={depth + 1}
          expanded={expanded} toggleExpand={toggleExpand} selectedPath={selectedPath} onSelect={onSelect} onError={onError}
        />
      )}
    </li>
  );
}

// ── Right pane: selected file/folder — actions + inline content / editor ─────
function FilePane({
  selected, autoEdit, onSelect, onError,
}: {
  selected: Selected; autoEdit: boolean;
  onSelect: (s: Selected) => void; onError: (e: string | null) => void;
}) {
  const utils = trpc.useUtils();
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
        <p className="text-xs">在左侧选择文件查看 / 编辑，或新建一个文件开始写。</p>
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
      await pullDownload(selected.path, isDir, selected.name, utils, prepare.mutateAsync);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }
  function doDelete() {
    if (!selected) return;
    if (!confirm(`删除${isDir ? '文件夹' : '文件'}「${selected.name}」${isDir ? '及其全部内容' : ''}？此操作不可撤销。`)) return;
    remove.mutate({ globalMemory: true, path: selected.path });
  }
  function commitRename() {
    if (!selected) return;
    const name = draft.trim();
    if (!name || name === selected.name) { setRenaming(false); return; }
    rename.mutate({ globalMemory: true, path: selected.path, toPath: joinPath(parentOf(selected.path), name) });
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
            <button onClick={commitRename} className="p-1 text-muted-foreground hover:text-foreground" title="保存"><Check className="h-4 w-4" /></button>
            <button onClick={() => setRenaming(false)} className="p-1 text-muted-foreground hover:text-foreground" title="取消"><X className="h-4 w-4" /></button>
          </>
        ) : (
          <>
            {!isDir && !isImg && !editing && (
              <button onClick={() => setEditing(true)} className="p-1 text-muted-foreground hover:text-foreground" title="编辑"><Pencil className="h-4 w-4" /></button>
            )}
            <button onClick={doDownload} disabled={downloading} className="p-1 text-muted-foreground hover:text-foreground" title={isDir ? '打包下载' : '下载'}>
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            </button>
            <button onClick={() => { setDraft(selected.name); setRenaming(true); }} className="p-1 text-muted-foreground hover:text-foreground" title="重命名"><Pencil className="h-4 w-4" /></button>
            <button onClick={doDelete} disabled={remove.isPending} className="p-1 text-muted-foreground hover:text-rose-500" title="删除">
              {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          </>
        )}
      </div>

      {/* Body: editor / inline content / folder summary */}
      <div className="flex-1 min-h-0 overflow-auto">
        {isDir ? (
          <div className="p-4 text-xs text-muted-foreground space-y-1">
            <p className="font-mono text-foreground/70 break-all">{selected.path || '(根目录)'}</p>
            <p>文件夹 — 在左侧展开浏览，或用上方按钮打包下载 / 重命名 / 删除。</p>
          </div>
        ) : editing && !isImg ? (
          <FileEditor path={selected.path} onError={onError} onDone={() => setEditing(false)} />
        ) : (
          <FileContent path={selected.path} size={selected.size} isImg={isImg} onDownload={doDownload} downloading={downloading} onEdit={() => setEditing(true)} />
        )}
      </div>
    </>
  );
}

function DownloadBtn({ onDownload, downloading }: { onDownload: () => void; downloading: boolean }) {
  return (
    <Button size="sm" variant="outline" onClick={onDownload} disabled={downloading}>
      {downloading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />} 下载文件
    </Button>
  );
}

// Editor — load current text, edit, save (writeText). Used for new + existing files.
function FileEditor({ path, onError, onDone }: { path: string; onError: (e: string | null) => void; onDone: () => void }) {
  const utils = trpc.useUtils();
  const q = trpc.fileManager.readText.useQuery({ globalMemory: true, path }, { retry: false });
  const [draft, setDraft] = useState<string | null>(null);
  const save = trpc.fileManager.writeText.useMutation({
    onSuccess: () => { utils.fileManager.readText.invalidate({ globalMemory: true, path }); utils.fileManager.list.invalidate(); onDone(); },
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
        placeholder="在此编写内容（Markdown）。保存后约 30 秒内被这台机器的 ~/.claude/CLAUDE.md 引用。"
        className="flex-1 min-h-[200px] w-full rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-foreground/30 resize-none"
      />
      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ globalMemory: true, path, text: value })}>
          {save.isPending ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> 保存中…</> : <><Save className="h-3.5 w-3.5 mr-1" /> 保存</>}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>取消</Button>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/60">{value.length} 字符</span>
      </div>
    </div>
  );
}

// Inline view (no modal): images render as <img>, text shows a preview; binary /
// oversized falls back to a download button.
function FileContent({
  path, size, isImg, onDownload, downloading, onEdit,
}: {
  path: string; size: number; isImg: boolean; onDownload: () => void; downloading: boolean; onEdit: () => void;
}) {
  return (
    <div className="p-3">
      <div className="mb-2 text-[11px] font-mono text-muted-foreground/60">{fmtSize(size)}</div>
      {isImg ? (
        size > PREVIEW_IMG_MAX ? (
          <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
            <p>图片较大（{fmtSize(size)}），不自动预览。</p>
            <DownloadBtn onDownload={onDownload} downloading={downloading} />
          </div>
        ) : (
          <ImagePreview key={path} path={path} onDownload={onDownload} downloading={downloading} />
        )
      ) : (
        <TextPreview path={path} onDownload={onDownload} downloading={downloading} onEdit={onEdit} />
      )}
    </div>
  );
}

function TextPreview({
  path, onDownload, downloading, onEdit,
}: {
  path: string; onDownload: () => void; downloading: boolean; onEdit: () => void;
}) {
  const q = trpc.fileManager.readText.useQuery({ globalMemory: true, path }, { retry: false });
  if (q.isPending) return <div className="h-40 rounded bg-accent/30 animate-pulse" />;
  if (q.error) {
    return (
      <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
        <p>{q.error.message}</p>
        <DownloadBtn onDownload={onDownload} downloading={downloading} />
      </div>
    );
  }
  if (!q.data?.text) {
    return (
      <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
        <p>空文件。</p>
        <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="h-3.5 w-3.5 mr-1" /> 编辑</Button>
      </div>
    );
  }
  return <pre className="text-[12px] font-mono whitespace-pre-wrap break-words text-foreground/90 leading-relaxed">{q.data.text}</pre>;
}

// Image preview via the prepared-download path (gateway → stash → blob).
function ImagePreview({
  path, onDownload, downloading,
}: {
  path: string; onDownload: () => void; downloading: boolean;
}) {
  const utils = trpc.useUtils();
  const prepareAsync = trpc.fileManager.prepareDownload.useMutation().mutateAsync;
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    let objUrl: string | undefined;
    void (async () => {
      try {
        const { blob } = await fetchPreparedBlob(path, false, utils, prepareAsync);
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
  }, [path, utils, prepareAsync]);

  if (state.error) {
    return (
      <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
        <p>预览失败：{state.error}</p>
        <DownloadBtn onDownload={onDownload} downloading={downloading} />
      </div>
    );
  }
  if (!state.url) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载预览…
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
