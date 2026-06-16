'use client';

// Per-agent file manager (the "文件" tab of the agent detail). Browses the
// agent's on-disk directory LIVE over the gateway control-channel (snappy — see
// server/gateway-bridge.ts), with upload (reuses File Station), download (a file,
// or a folder zipped by the gateway), delete, rename, new-folder and a text
// preview. Performance: one query per directory (lazy, never recursive), the
// gateway caps + sorts the listing, and the client renders incrementally.

import { useMemo, useRef, useState } from 'react';
import {
  Folder, File as FileIcon, Download, Upload, Trash2, Pencil, FolderPlus,
  ChevronRight, ArrowUp, RotateCw, Loader2, FileText, X, Check,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { getActiveKey } from '@/lib/keyring';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Overlay } from '@/components/overlay';

const MAX_UPLOAD = 100 * 1024 * 1024; // 100 MB per the spec
const RENDER_CAP = 300; // rows rendered before "show all" (keeps the DOM light)

type Entry = { name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number };

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const joinPath = (base: string, name: string) => (base ? `${base}/${name}` : name);
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Raw XHR upload (fetch gives no progress). Reuses the File Station endpoint —
// the gateway writes it into the agent dir at `destPath`.
function uploadXhr(file: File, destPath: string, onProgress: (p: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/file-station/upload');
    xhr.setRequestHeader('x-asst-key', getActiveKey());
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('x-file-path', encodeURIComponent(destPath));
    xhr.setRequestHeader('x-file-unzip', '0');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve({ id: '' });
        }
      } else {
        let msg = `上传失败 (${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch {
          /* keep default */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });
}

export function AgentFiles({ agentName, directory }: { agentName: string; directory: string | null | undefined }) {
  const utils = trpc.useUtils();
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const list = trpc.fileManager.list.useQuery({ agentName, path }, { enabled: !!directory, retry: false });
  const entries = useMemo(() => (list.data?.entries ?? []) as Entry[], [list.data]);
  const shown = showAll ? entries : entries.slice(0, RENDER_CAP);

  // Navigate + clear transient per-directory state in one go (no effect → no
  // cascading-render lint).
  const navigate = (p: string) => {
    setPath(p);
    setShowAll(false);
    setError(null);
  };

  if (!directory) {
    return <p className="text-xs text-muted-foreground py-4">agent 目录未知（尚未被网关扫描到），暂无法浏览文件。</p>;
  }

  const crumbs = path ? path.split('/') : [];

  return (
    <div className="space-y-2">
      <Toolbar
        agentName={agentName}
        directory={directory}
        path={path}
        onRefresh={() => utils.fileManager.list.invalidate({ agentName, path })}
        onError={setError}
      />

      {/* Breadcrumb */}
      <div className="flex items-center gap-0.5 text-xs text-muted-foreground flex-wrap">
        <button onClick={() => navigate('')} className="hover:text-foreground transition-colors cursor-pointer font-mono">
          {agentName}
        </button>
        {crumbs.map((seg, i) => {
          const target = crumbs.slice(0, i + 1).join('/');
          return (
            <span key={target} className="flex items-center gap-0.5">
              <ChevronRight className="h-3 w-3 opacity-50" />
              <button onClick={() => navigate(target)} className="hover:text-foreground transition-colors cursor-pointer font-mono">
                {seg}
              </button>
            </span>
          );
        })}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-500">
          <span className="flex-1 break-words">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        {/* Up a level */}
        {path && (
          <button
            onClick={() => navigate(parentOf(path))}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/40 transition-colors cursor-pointer border-b border-border"
          >
            <ArrowUp className="h-4 w-4" /> ..
          </button>
        )}

        {list.isPending ? (
          <div className="p-3 space-y-1.5">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-7 rounded bg-accent/40 animate-pulse" />)}
          </div>
        ) : list.error ? (
          <p className="px-3 py-4 text-xs text-rose-500">{list.error.message}</p>
        ) : entries.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">空目录。</p>
        ) : (
          <ul>
            {shown.map((e) => (
              <FileRow
                key={e.name}
                entry={e}
                agentName={agentName}
                relPath={joinPath(path, e.name)}
                onOpen={() => e.type === 'dir' && navigate(joinPath(path, e.name))}
                onError={setError}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
        <span>{entries.length} 项{list.data?.truncated ? `（已截断，目录过大）` : ''}</span>
        {!showAll && entries.length > RENDER_CAP && (
          <button onClick={() => setShowAll(true)} className="hover:text-foreground cursor-pointer">显示全部 {entries.length} 项</button>
        )}
      </div>
    </div>
  );
}

// ── Toolbar: upload + new folder ─────────────────────────────────────────────
function Toolbar({
  agentName, directory, path, onRefresh, onError,
}: {
  agentName: string; directory: string; path: string; onRefresh: () => void; onError: (e: string | null) => void;
}) {
  const utils = trpc.useUtils();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [justUploaded, setJustUploaded] = useState<string | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [folderName, setFolderName] = useState('');

  const mkdir = trpc.fileManager.mkdir.useMutation({
    onSuccess: () => { utils.fileManager.list.invalidate({ agentName, path }); setMkdirOpen(false); setFolderName(''); },
    onError: (e) => onError(e.message),
  });

  const destDir = (path ? `${directory}/${path}` : directory) + '/';

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
      setJustUploaded(f.name);
      // The gateway writes it on its next ~4s File Station tick — re-list a few
      // times so the new file shows without a manual refresh.
      for (const ms of [500, 2500, 5000]) setTimeout(() => utils.fileManager.list.invalidate({ agentName, path }), ms);
      setTimeout(() => setJustUploaded((n) => (n === f.name ? null : n)), 7000);
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
          {pct !== null ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
          上传
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMkdirOpen((v) => !v)} title="新建文件夹">
          <FolderPlus className="h-3.5 w-3.5 mr-1" /> 新建文件夹
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onRefresh} title="刷新" className="ml-auto">
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
      {justUploaded && <div className="text-[11px] text-emerald-500">已上传 {justUploaded}（网关写入中，稍候自动出现）</div>}

      {mkdirOpen && (
        <div className="flex items-center gap-1.5">
          <input
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && folderName.trim()) mkdir.mutate({ agentName, path: joinPath(path, folderName.trim()) }); }}
            placeholder="文件夹名"
            autoFocus
            className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-foreground/30"
          />
          <Button size="icon-sm" variant="ghost" disabled={!folderName.trim() || mkdir.isPending} onClick={() => mkdir.mutate({ agentName, path: joinPath(path, folderName.trim()) })}><Check className="h-3.5 w-3.5" /></Button>
          <Button size="icon-sm" variant="ghost" onClick={() => { setMkdirOpen(false); setFolderName(''); }}><X className="h-3.5 w-3.5" /></Button>
        </div>
      )}
    </div>
  );
}

// ── One row (file or folder) ─────────────────────────────────────────────────
function FileRow({
  entry, agentName, relPath, onOpen, onError,
}: {
  entry: Entry; agentName: string; relPath: string; onOpen: () => void; onError: (e: string | null) => void;
}) {
  const utils = trpc.useUtils();
  const isDir = entry.type === 'dir';
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(entry.name);
  const [busy, setBusy] = useState<null | 'download' | 'delete'>(null);
  const [preview, setPreview] = useState(false);

  const remove = trpc.fileManager.remove.useMutation({
    onSuccess: () => utils.fileManager.list.invalidate(),
    onError: (e) => { onError(e.message); setBusy(null); },
  });
  const rename = trpc.fileManager.rename.useMutation({
    onSuccess: () => { utils.fileManager.list.invalidate(); setRenaming(false); },
    onError: (e) => onError(e.message),
  });
  const prepare = trpc.fileManager.prepareDownload.useMutation();

  async function doDownload() {
    onError(null);
    setBusy('download');
    try {
      const { id } = await prepare.mutateAsync({ agentName, path: relPath, isFolder: isDir });
      // Poll until the gateway has streamed the bytes up to the stash.
      for (let i = 0; i < 180; i++) {
        await sleep(2000);
        const s = await utils.fileManager.downloadStatus.fetch({ id });
        if (s.status === 'ready') {
          const res = await fetch(`/api/file-manager/download/${encodeURIComponent(id)}`, { headers: { 'x-asst-key': getActiveKey() } });
          if (!res.ok) throw new Error(`下载失败 (${res.status})`);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = s.filename || entry.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          return;
        }
        if (s.status === 'error') throw new Error(s.error || '准备下载失败');
      }
      throw new Error('下载超时');
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function doDelete() {
    if (!confirm(`删除 ${isDir ? '文件夹' : '文件'}「${entry.name}」${isDir ? '及其全部内容' : ''}？此操作不可撤销。`)) return;
    setBusy('delete');
    remove.mutate({ agentName, path: relPath });
  }

  if (renaming) {
    return (
      <li className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border last:border-0">
        {isDir ? <Folder className="h-4 w-4 text-sky-500 shrink-0" /> : <FileIcon className="h-4 w-4 text-muted-foreground shrink-0" />}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim() && draft !== entry.name) rename.mutate({ agentName, path: relPath, toPath: joinPath(parentOf(relPath), draft.trim()) });
            if (e.key === 'Escape') setRenaming(false);
          }}
          autoFocus
          className="h-7 flex-1 rounded border border-border bg-background px-2 text-sm outline-none focus:border-foreground/30"
        />
        <button onClick={() => draft.trim() && draft !== entry.name ? rename.mutate({ agentName, path: relPath, toPath: joinPath(parentOf(relPath), draft.trim()) }) : setRenaming(false)} className="text-muted-foreground hover:text-foreground"><Check className="h-3.5 w-3.5" /></button>
        <button onClick={() => { setRenaming(false); setDraft(entry.name); }} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
      </li>
    );
  }

  return (
    <li className="group flex items-center gap-2 px-3 py-1.5 border-b border-border last:border-0 hover:bg-accent/30 transition-colors">
      <button onClick={onOpen} className={cn('flex items-center gap-2 min-w-0 flex-1', isDir && 'cursor-pointer')} disabled={!isDir}>
        {isDir ? <Folder className="h-4 w-4 text-sky-500 shrink-0" /> : <FileIcon className="h-4 w-4 text-muted-foreground shrink-0" />}
        <span className={cn('truncate text-sm', isDir ? 'text-foreground' : 'text-foreground/85')}>{entry.name}</span>
      </button>
      <span className="shrink-0 text-[11px] font-mono text-muted-foreground/60 tabular-nums w-16 text-right">{entry.type === 'file' ? fmtSize(entry.size) : ''}</span>
      <span className="shrink-0 text-[11px] font-mono text-muted-foreground/50 tabular-nums hidden sm:block w-20 text-right">{relTime(new Date(entry.mtimeMs))}</span>
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {entry.type === 'file' && (
          <button onClick={() => setPreview(true)} title="预览" className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent"><FileText className="h-3.5 w-3.5" /></button>
        )}
        <button onClick={doDownload} disabled={busy !== null} title={isDir ? '打包下载' : '下载'} className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent">
          {busy === 'download' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        </button>
        <button onClick={() => { setDraft(entry.name); setRenaming(true); }} title="重命名" className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent"><Pencil className="h-3.5 w-3.5" /></button>
        <button onClick={doDelete} disabled={busy !== null} title="删除" className="p-1 text-muted-foreground hover:text-rose-500 rounded hover:bg-accent">
          {busy === 'delete' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      </div>
      {preview && <TextPreview agentName={agentName} relPath={relPath} name={entry.name} onClose={() => setPreview(false)} />}
    </li>
  );
}

// ── Text preview modal ───────────────────────────────────────────────────────
function TextPreview({ agentName, relPath, name, onClose }: { agentName: string; relPath: string; name: string; onClose: () => void }) {
  const q = trpc.fileManager.readText.useQuery({ agentName, path: relPath }, { retry: false });
  return (
    <Overlay onClose={onClose} panelClassName="w-full max-w-3xl">
      {(close) => (
        <div className="flex flex-col max-h-[80vh] rounded-lg border border-border bg-card shadow-xl overflow-hidden">
          <div className="flex items-center gap-2 px-3 h-10 border-b border-border shrink-0">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="font-mono text-sm truncate flex-1">{name}</span>
            <button onClick={close} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-3">
            {q.isPending ? (
              <div className="h-32 rounded bg-accent/40 animate-pulse" />
            ) : q.error ? (
              <p className="text-xs text-rose-500">{q.error.message}</p>
            ) : (
              <pre className="text-[12px] font-mono whitespace-pre-wrap break-words text-foreground/90">{q.data?.text}</pre>
            )}
          </div>
        </div>
      )}
    </Overlay>
  );
}
