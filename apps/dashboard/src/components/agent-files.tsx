'use client';

// Per-agent file manager (the "文件" tab of the agent detail) — a classic
// two-pane explorer: a lazy file TREE on the left, the selected file's content
// (inline, no modal) on the right. Browses the agent's on-disk directory LIVE
// over the gateway control-channel (snappy — see server/gateway-bridge.ts).
// Upload reuses File Station; download streams a file as-is or a folder zipped by
// the gateway. Performance: one query per expanded directory (lazy, never
// recursive), the gateway caps + sorts each listing.

import { useEffect, useRef, useState } from 'react';
import {
  Folder, FolderOpen, File as FileIcon, Download, Upload, Trash2, Pencil,
  FolderPlus, ChevronRight, RotateCw, Loader2, X, Check, FileText,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { getActiveKey } from '@/lib/keyring';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Button } from '@/components/ui/button';

const MAX_UPLOAD = 100 * 1024 * 1024; // 100 MB per the spec
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const PREVIEW_IMG_MAX = 25 * 1024 * 1024; // auto-preview images up to 25 MB; bigger → download only

type PrepareAsync = (vars: { agentName: string; path: string; isFolder: boolean }) => Promise<{ id: string }>;

type Entry = { name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number };
type Selected = { path: string; name: string; type: 'dir' | 'file' | 'other'; size: number } | null;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const joinPath = (base: string, name: string) => (base ? `${base}/${name}` : name);
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function uploadXhr(file: File, destPath: string, onProgress: (p: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/file-station/upload');
    xhr.setRequestHeader('x-asst-key', getActiveKey());
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('x-file-path', encodeURIComponent(destPath));
    xhr.setRequestHeader('x-file-unzip', '0');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ id: '' }); }
      } else {
        let msg = `上传失败 (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });
}

// Fetch a prepared download (a file, or a gateway-zipped folder) as a Blob:
// trigger the gateway prepare, poll until it's stashed, then pull the bytes.
// Shared by the download action and the inline image preview.
async function fetchPreparedBlob(
  agentName: string,
  path: string,
  isFolder: boolean,
  utils: ReturnType<typeof trpc.useUtils>,
  prepareAsync: PrepareAsync,
): Promise<{ blob: Blob; filename: string }> {
  const { id } = await prepareAsync({ agentName, path, isFolder });
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

// Save a prepared download to disk (synthetic anchor — the key can't ride <a>).
async function pullDownload(
  agentName: string,
  path: string,
  isFolder: boolean,
  fallbackName: string,
  utils: ReturnType<typeof trpc.useUtils>,
  prepareAsync: PrepareAsync,
): Promise<void> {
  const { blob, filename } = await fetchPreparedBlob(agentName, path, isFolder, utils, prepareAsync);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function AgentFiles({ agentName, directory }: { agentName: string; directory: string | null | undefined }) {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<Selected>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  if (!directory) {
    return <p className="text-xs text-muted-foreground py-4">agent 目录未知（尚未被网关扫描到），暂无法浏览文件。</p>;
  }

  const toggleExpand = (path: string, force?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      const open = force ?? !next.has(path);
      if (open) next.add(path); else next.delete(path);
      return next;
    });

  // Upload / new-folder target: the selected folder, or the parent of the
  // selected file, else the agent root.
  const activeDir = selected ? (selected.type === 'dir' ? selected.path : parentOf(selected.path)) : '';

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2 p-3 sm:p-4">
      {error && (
        <div className="shrink-0 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-500">
          <span className="flex-1 break-words">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <Toolbar
        agentName={agentName}
        directory={directory}
        activeDir={activeDir}
        onError={setError}
        onMkdir={(p) => toggleExpand(p, true)}
        onRefresh={() => utils.fileManager.list.invalidate()}
      />

      <div className="flex flex-1 min-h-[260px] rounded-lg border border-border overflow-hidden">
        {/* Left: lazy file tree */}
        <div className="w-2/5 min-w-[150px] max-w-[320px] shrink-0 border-r border-border overflow-y-auto bg-muted/20">
          <TreeChildren
            agentName={agentName} path="" depth={0}
            expanded={expanded} toggleExpand={toggleExpand}
            selectedPath={selected?.path ?? null} onSelect={setSelected} onError={setError}
          />
        </div>
        {/* Right: selected file/folder content + actions (inline, no modal) */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <FilePane agentName={agentName} selected={selected} onSelect={setSelected} onError={setError} />
        </div>
      </div>
    </div>
  );
}

// ── Toolbar: upload + new folder, targeting the active directory ─────────────
function Toolbar({
  agentName, directory, activeDir, onError, onMkdir, onRefresh,
}: {
  agentName: string; directory: string; activeDir: string;
  onError: (e: string | null) => void; onMkdir: (path: string) => void; onRefresh: () => void;
}) {
  const utils = trpc.useUtils();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [folderName, setFolderName] = useState('');

  const mkdir = trpc.fileManager.mkdir.useMutation({
    onSuccess: () => { utils.fileManager.list.invalidate({ agentName, path: activeDir }); onMkdir(activeDir); setMkdirOpen(false); setFolderName(''); },
    onError: (e) => onError(e.message),
  });

  const destDir = (activeDir ? `${directory}/${activeDir}` : directory) + '/';

  async function onPick(f: File | null) {
    onError(null);
    if (!f) return;
    if (f.size > MAX_UPLOAD) {
      onError(`文件 ${fmtSize(f.size)} 超过 100MB 上限`);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setPct(0);
    try {
      await uploadXhr(f, destDir, setPct);
      setPct(null);
      // The gateway writes it on its next ~4s File Station tick — re-list the
      // target a few times so the new file appears.
      for (const ms of [500, 2500, 5000]) setTimeout(() => utils.fileManager.list.invalidate({ agentName, path: activeDir }), ms);
    } catch (e) {
      setPct(null);
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <input ref={fileRef} type="file" className="hidden" onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
        <Button size="sm" variant="outline" disabled={pct !== null} onClick={() => fileRef.current?.click()}>
          {pct !== null ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1" />} 上传
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMkdirOpen((v) => !v)} title="新建文件夹">
          <FolderPlus className="h-3.5 w-3.5 mr-1" /> 新建文件夹
        </Button>
        <span className="text-[11px] text-muted-foreground/70 font-mono truncate min-w-0">→ {agentName}{activeDir ? `/${activeDir}` : ''}</span>
        <Button size="icon-sm" variant="ghost" onClick={onRefresh} title="刷新" className="ml-auto shrink-0">
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {pct !== null && (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.round(pct * 100)}%` }} />
          </div>
          <div className="text-[11px] text-muted-foreground">上传中… {Math.round(pct * 100)}%</div>
        </div>
      )}

      {mkdirOpen && (
        <div className="flex items-center gap-1.5">
          <input
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && folderName.trim()) mkdir.mutate({ agentName, path: joinPath(activeDir, folderName.trim()) }); }}
            placeholder={`在 ${activeDir || agentName} 下新建文件夹`}
            autoFocus
            className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-foreground/30"
          />
          <Button size="icon-sm" variant="ghost" disabled={!folderName.trim() || mkdir.isPending} onClick={() => mkdir.mutate({ agentName, path: joinPath(activeDir, folderName.trim()) })}><Check className="h-3.5 w-3.5" /></Button>
          <Button size="icon-sm" variant="ghost" onClick={() => { setMkdirOpen(false); setFolderName(''); }}><X className="h-3.5 w-3.5" /></Button>
        </div>
      )}
    </div>
  );
}

// ── Tree: the lazily-loaded children of one directory ────────────────────────
function TreeChildren({
  agentName, path, depth, expanded, toggleExpand, selectedPath, onSelect, onError,
}: {
  agentName: string; path: string; depth: number;
  expanded: Set<string>; toggleExpand: (p: string, force?: boolean) => void;
  selectedPath: string | null; onSelect: (s: Selected) => void; onError: (e: string | null) => void;
}) {
  const list = trpc.fileManager.list.useQuery({ agentName, path }, { retry: false });
  const indent = depth * 12 + 8;

  if (list.isPending) {
    return <div style={{ paddingLeft: indent + 16 }} className="py-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /></div>;
  }
  if (list.error) {
    return <div style={{ paddingLeft: indent + 16 }} className="py-1 text-[11px] text-rose-500 pr-2 break-words">{list.error.message}</div>;
  }
  const entries = (list.data?.entries ?? []) as Entry[];
  if (entries.length === 0) {
    return <div style={{ paddingLeft: indent + 16 }} className="py-1 text-[11px] text-muted-foreground/50">空</div>;
  }
  return (
    <ul>
      {entries.map((e) => (
        <TreeNode
          key={e.name}
          agentName={agentName} entry={e} path={joinPath(path, e.name)} depth={depth}
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
  agentName, entry, path, depth, expanded, toggleExpand, selectedPath, onSelect, onError,
}: {
  agentName: string; entry: Entry; path: string; depth: number;
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
          agentName={agentName} path={path} depth={depth + 1}
          expanded={expanded} toggleExpand={toggleExpand} selectedPath={selectedPath} onSelect={onSelect} onError={onError}
        />
      )}
    </li>
  );
}

// ── Right pane: selected file/folder — actions + inline content ──────────────
function FilePane({
  agentName, selected, onSelect, onError,
}: {
  agentName: string; selected: Selected; onSelect: (s: Selected) => void; onError: (e: string | null) => void;
}) {
  const utils = trpc.useUtils();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [downloading, setDownloading] = useState(false);

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
        <p className="text-xs">在左侧选择文件查看内容，或选择文件夹进行操作。</p>
      </div>
    );
  }

  const isDir = selected.type === 'dir';

  async function doDownload() {
    if (!selected) return;
    onError(null);
    setDownloading(true);
    try {
      await pullDownload(agentName, selected.path, isDir, selected.name, utils, prepare.mutateAsync);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }
  function doDelete() {
    if (!selected) return;
    if (!confirm(`删除${isDir ? '文件夹' : '文件'}「${selected.name}」${isDir ? '及其全部内容' : ''}？此操作不可撤销。`)) return;
    remove.mutate({ agentName, path: selected.path });
  }
  function commitRename() {
    if (!selected) return;
    const name = draft.trim();
    if (!name || name === selected.name) { setRenaming(false); return; }
    rename.mutate({ agentName, path: selected.path, toPath: joinPath(parentOf(selected.path), name) });
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

      {/* Body: file content (inline) or folder summary */}
      <div className="flex-1 min-h-0 overflow-auto">
        {isDir ? (
          <div className="p-4 text-xs text-muted-foreground space-y-1">
            <p className="font-mono text-foreground/70 break-all">{selected.path || '(根目录)'}</p>
            <p>文件夹 — 在左侧展开浏览，或用上方按钮打包下载 / 重命名 / 删除。</p>
          </div>
        ) : (
          <FileContent agentName={agentName} path={selected.path} size={selected.size} onDownload={doDownload} downloading={downloading} />
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

// Inline preview (no modal): images render as <img>, everything else tries a
// text preview; binary / oversized falls back to a download button.
function FileContent({
  agentName, path, size, onDownload, downloading,
}: {
  agentName: string; path: string; size: number; onDownload: () => void; downloading: boolean;
}) {
  const name = path.split('/').pop() ?? '';
  const isImg = IMAGE_RE.test(name);
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
          <ImagePreview key={path} agentName={agentName} path={path} onDownload={onDownload} downloading={downloading} />
        )
      ) : (
        <TextPreview agentName={agentName} path={path} onDownload={onDownload} downloading={downloading} />
      )}
    </div>
  );
}

function TextPreview({
  agentName, path, onDownload, downloading,
}: {
  agentName: string; path: string; onDownload: () => void; downloading: boolean;
}) {
  const q = trpc.fileManager.readText.useQuery({ agentName, path }, { retry: false });
  if (q.isPending) return <div className="h-40 rounded bg-accent/30 animate-pulse" />;
  if (q.error) {
    return (
      <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
        <p>{q.error.message}</p>
        <DownloadBtn onDownload={onDownload} downloading={downloading} />
      </div>
    );
  }
  return <pre className="text-[12px] font-mono whitespace-pre-wrap break-words text-foreground/90 leading-relaxed">{q.data?.text}</pre>;
}

// Image preview — pull the bytes via the same prepared-download path (gateway →
// stash → blob), render as an object URL. Keyed by path so it refetches cleanly
// on file change; the object URL is revoked on unmount.
function ImagePreview({
  agentName, path, onDownload, downloading,
}: {
  agentName: string; path: string; onDownload: () => void; downloading: boolean;
}) {
  const utils = trpc.useUtils();
  const prepareAsync = trpc.fileManager.prepareDownload.useMutation().mutateAsync;
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    let objUrl: string | undefined;
    void (async () => {
      try {
        const { blob } = await fetchPreparedBlob(agentName, path, false, utils, prepareAsync);
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
  }, [agentName, path, utils, prepareAsync]);

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
