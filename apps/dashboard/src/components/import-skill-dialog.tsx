'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// Import a skill into the market from an external URL (master-skill.org / GitHub /
// raw SKILL.md). Preview (server-side fetch) → optionally edit slug/name → commit
// (server re-fetches; client content is never trusted). See market-import.ts.
export function ImportSkillDialog({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const [url, setUrl] = useState('');
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const preview = trpc.market.previewImport.useMutation({
    onSuccess: (p) => { setSlug(p.slug); setDisplayName(p.displayName); setDone(null); },
  });
  const commit = trpc.market.commitImport.useMutation({
    onSuccess: (r) => { utils.market.listSkills.invalidate(); setDone(`${r.slug} · v${r.latestVersion}`); },
  });
  const p = preview.data;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 shrink-0">
          <span className="text-sm font-medium">Import skill from URL</span>
          <button type="button" onClick={onClose} aria-label="close" className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
          <div className="flex items-end gap-2">
            <label className="block flex-1 min-w-0">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">URL</span>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://master-skill.org/install/… or a GitHub SKILL.md" className="mt-1.5 text-sm" />
            </label>
            <Button size="sm" disabled={!url.trim() || preview.isPending} onClick={() => preview.mutate({ url: url.trim() })}>
              {preview.isPending ? 'fetching…' : 'Preview'}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/70">支持 master-skill.org 的 install/skill 链接、GitHub 的 SKILL.md(blob/raw/目录)、或任意指向 SKILL.md 的链接。</p>
          {preview.error && <p className="text-xs text-rose-500">{preview.error.message}</p>}

          {p && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="rounded border px-1.5 py-px font-mono text-muted-foreground">{p.origin === 'master-skill.org' ? 'master.skill' : p.origin}</span>
                {p.refCount > 0 && <span className="text-muted-foreground/70">+{p.refCount} file{p.refCount === 1 ? '' : 's'}</span>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Slug</span>
                  <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} className="mt-1 font-mono text-xs" />
                </label>
                <label className="block">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Display name</span>
                  <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="mt-1 text-xs" />
                </label>
              </div>
              {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
              <div>
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">SKILL.md preview</span>
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/40 p-2 text-[11px] font-mono whitespace-pre-wrap break-words">{p.content.slice(0, 4000)}{p.content.length > 4000 ? '\n…' : ''}</pre>
              </div>
              {commit.error && <p className="text-xs text-rose-500">{commit.error.message}</p>}
            </div>
          )}
        </div>

        <div className="border-t px-4 py-2.5 shrink-0 flex items-center justify-end gap-2">
          {done && <span className="mr-auto text-[11px] text-emerald-500 inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" /> imported {done}</span>}
          <button type="button" onClick={onClose} className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:bg-accent cursor-pointer">{done ? 'Close' : 'Cancel'}</button>
          {p && !done && (
            <Button size="sm" disabled={!slug.trim() || commit.isPending} onClick={() => commit.mutate({ url: url.trim(), slug: slug.trim(), displayName: displayName.trim() || undefined })}>
              {commit.isPending ? 'importing…' : 'Import to market'}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
