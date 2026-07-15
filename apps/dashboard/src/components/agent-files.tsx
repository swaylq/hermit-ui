'use client';

// Per-agent file manager (the "Files" tab of the agent detail) — a classic
// two-pane explorer: a lazy file TREE on the left, the selected file's content
// (inline, no modal) on the right. Browses the agent's on-disk directory LIVE
// over the gateway control-channel (snappy — see server/gateway-bridge.ts).
// Upload reuses File Station; download streams a file as-is or a folder zipped by
// the gateway. Performance: one query per expanded directory (lazy, never
// recursive), the gateway caps + sorts each listing.

import { useMemo, useRef, useState } from 'react';
import { Upload, FolderPlus, RotateCw, Loader2, X, Check } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { getActiveKey } from '@/lib/keyring';
import { Button } from '@/components/ui/button';
import { type Selected, fmtSize, joinPath, parentOf } from '@/components/file-explorer/core';
import { FileTree } from '@/components/file-explorer/file-tree';
import { FilePane } from '@/components/file-explorer/file-pane';

const MAX_UPLOAD = 100 * 1024 * 1024; // 100 MB per the spec

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
        let msg = `Upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(file);
  });
}

export function AgentFiles({ agentName, directory }: { agentName: string; directory: string | null | undefined }) {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<Selected>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Stable across renders so the shared FilePane's ImagePreview effect doesn't
  // refetch every render (see file-pane.tsx).
  const source = useMemo(() => ({ kind: 'agent' as const, agentName }), [agentName]);

  if (!directory) {
    return <p className="text-xs text-muted-foreground py-4">Agent directory unknown (not yet scanned by the gateway) — can&rsquo;t browse files yet.</p>;
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
          <FileTree
            source={source} path="" depth={0}
            expanded={expanded} toggleExpand={toggleExpand}
            selectedPath={selected?.path ?? null} onSelect={setSelected} onError={setError}
          />
        </div>
        {/* Right: selected file/folder content + actions (inline, no modal) */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <FilePane source={source} selected={selected} onSelect={setSelected} onError={setError} />
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
      onError(`File ${fmtSize(f.size)} exceeds the 100 MB limit`);
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
          {pct !== null ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1" />} Upload
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMkdirOpen((v) => !v)} title="New folder">
          <FolderPlus className="h-3.5 w-3.5 mr-1" /> New folder
        </Button>
        <span className="text-[11px] text-muted-foreground/70 font-mono truncate min-w-0">→ {agentName}{activeDir ? `/${activeDir}` : ''}</span>
        <Button size="icon-sm" variant="ghost" onClick={onRefresh} title="Refresh" className="ml-auto shrink-0">
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {pct !== null && (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.round(pct * 100)}%` }} />
          </div>
          <div className="text-[11px] text-muted-foreground">Uploading… {Math.round(pct * 100)}%</div>
        </div>
      )}

      {mkdirOpen && (
        <div className="flex items-center gap-1.5">
          <input
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && folderName.trim()) mkdir.mutate({ agentName, path: joinPath(activeDir, folderName.trim()) }); }}
            placeholder={`New folder in ${activeDir || agentName}`}
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
