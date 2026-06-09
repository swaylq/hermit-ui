'use client';

import { useRef, useState } from 'react';
import { X, Check, UploadCloud, FileArchive } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Overlay } from '@/components/overlay';
import { getActiveKey } from '@/lib/keyring';

type Result = { slug: string; latestVersion: string; created: boolean; fileCount: number; skipped: string[] };

// Upload a skill package (.zip rooted at a SKILL.md) to the market. The server
// unzips + parses (POST /api/market/skills/upload); a new market skill is created
// or a new version appended by slug. Mirrors ImportSkillDialog but file-based.
export function UploadSkillDialog({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [changelog, setChangelog] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Result | null>(null);

  function pick(f: File | null) {
    setError(null);
    setDone(null);
    if (f && !/\.zip$/i.test(f.name)) {
      setError('please choose a .zip file');
      return;
    }
    setFile(f);
    // seed slug from the filename (minus .zip), sanitized — editable below.
    if (f && !slug) {
      const base = f.name.replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      setSlug(base);
    }
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (slug.trim()) fd.append('slug', slug.trim());
      if (displayName.trim()) fd.append('displayName', displayName.trim());
      if (changelog.trim()) fd.append('changelog', changelog.trim());
      const res = await fetch('/api/market/skills/upload', {
        method: 'POST',
        headers: { 'x-asst-key': getActiveKey() },
        body: fd,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j?.error || `upload failed (${res.status})`);
        return;
      }
      setDone({ slug: j.slug, latestVersion: j.latestVersion, created: j.created, fileCount: j.fileCount, skipped: j.skipped ?? [] });
      utils.market.listSkills.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose} panelClassName="w-full max-w-lg max-h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl">
      {(close) => (
        <>
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 shrink-0">
            <span className="text-sm font-medium">Upload skill package (.zip)</span>
            <button type="button" onClick={close} aria-label="close" className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent cursor-pointer">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); pick(e.dataTransfer.files?.[0] ?? null); }}
              className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center cursor-pointer transition-colors ${dragOver ? 'border-foreground/40 bg-accent/40' : 'border-border hover:border-foreground/30 hover:bg-accent/20'}`}
            >
              {file ? (
                <>
                  <FileArchive className="h-7 w-7 text-emerald-500" />
                  <span className="text-sm font-mono break-all">{file.name}</span>
                  <span className="text-[11px] text-muted-foreground">{(file.size / 1024).toFixed(1)} KB · 点击更换</span>
                </>
              ) : (
                <>
                  <UploadCloud className="h-7 w-7 text-muted-foreground/60" />
                  <span className="text-sm text-muted-foreground">拖入或点击选择 <b>.zip</b></span>
                  <span className="text-[11px] text-muted-foreground/70">压缩包根目录或单层文件夹里要有 SKILL.md，最大 5 MB</span>
                </>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Slug</span>
                <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="from SKILL.md / folder" className="mt-1 font-mono text-xs" />
              </label>
              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Display name</span>
                <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="optional" className="mt-1 text-xs" />
              </label>
            </div>
            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Changelog</span>
              <Input value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="optional — note for this version" className="mt-1 text-xs" />
            </label>

            <p className="text-[10px] text-muted-foreground/70">
              Slug 留空就用 SKILL.md frontmatter 的 name（或顶层文件夹名）。同名已存在则追加为新版本；内容一模一样则跳过。二进制文件（图片/字体）会被跳过。
            </p>

            {error && <p className="text-xs text-rose-500">{error}</p>}

            {done && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-1 text-xs">
                <div className="inline-flex items-center gap-1 text-emerald-500 font-medium">
                  <Check className="h-3.5 w-3.5" />
                  {done.created ? `已发布 ${done.slug} · v${done.latestVersion}` : `${done.slug} 内容未变，跳过（仍是 v${done.latestVersion}）`}
                </div>
                <div className="text-muted-foreground">{done.fileCount} 个文件入库。</div>
                {done.skipped.length > 0 && (
                  <div className="text-amber-600 dark:text-amber-400">跳过 {done.skipped.length} 个：{done.skipped.slice(0, 6).join('、')}{done.skipped.length > 6 ? '…' : ''}</div>
                )}
              </div>
            )}
          </div>

          <div className="border-t px-4 py-2.5 shrink-0 flex items-center justify-end gap-2">
            <button type="button" onClick={close} className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:bg-accent cursor-pointer">{done ? 'Close' : 'Cancel'}</button>
            {!done && (
              <Button size="sm" disabled={!file || busy} onClick={submit}>
                {busy ? 'uploading…' : 'Upload to market'}
              </Button>
            )}
          </div>
        </>
      )}
    </Overlay>
  );
}
