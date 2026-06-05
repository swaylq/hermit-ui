'use client';

import { useState } from 'react';
import { X, Check } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Overlay } from '@/components/overlay';

// Condense an agent into a marketplace template. Shows what's KEPT vs STRIPPED
// (private traits) before publishing. Server-side strip — see market-template.ts.
export function PublishTemplateDialog({ agentName, onClose }: { agentName: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const preview = trpc.market.templatePreview.useQuery({ agentName });
  const [slug, setSlug] = useState(agentName);
  const [displayName, setDisplayName] = useState(agentName);
  const [description, setDescription] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const publish = trpc.market.publishTemplateFromAgent.useMutation({
    onSuccess: (r) => { utils.market.listTemplates.invalidate(); setDone(`${r.slug} · v${r.latestVersion}`); },
  });
  const p = preview.data;

  return (
    <Overlay onClose={onClose} panelClassName="w-full max-w-md max-h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl">
      {(close) => (
        <>
          <div className="flex items-center justify-between border-b px-4 py-2.5 shrink-0">
            <span className="text-sm font-medium">Publish as template</span>
            <button type="button" onClick={close} aria-label="close" className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent cursor-pointer">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              把 <span className="font-mono text-foreground/90">{agentName}</span> 凝练成模板发布到舰队市场。会剥掉私有内容,名字替换成占位符。
            </p>
            {preview.isLoading && <p className="text-xs text-muted-foreground">analyzing…</p>}
            {preview.error && <p className="text-xs text-rose-500">{preview.error.message}</p>}
            {p && (
              <div className="space-y-2 rounded-lg border border-border p-3 text-xs">
                <div>
                  <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">保留 ({p.kept.length})</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.kept.map((k) => <span key={k} className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-px font-mono text-[10px] text-emerald-700 dark:text-emerald-300">{k}</span>)}
                    {p.kept.length === 0 && <span className="text-muted-foreground/60">（agent 还没同步出 identity/skills）</span>}
                  </div>
                </div>
                <div>
                  <span className="text-[10px] font-medium uppercase tracking-wide text-rose-500">剥除</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.stripped.map((s) => <span key={s} className="rounded border border-rose-500/25 bg-rose-500/5 px-1.5 py-px text-[10px] text-rose-500/90">{s}</span>)}
                  </div>
                </div>
              </div>
            )}
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
            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Description <span className="opacity-50">(optional)</span></span>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what kind of agent is this?" className="mt-1 text-xs" />
            </label>
            {publish.error && <p className="text-xs text-rose-500">{publish.error.message}</p>}
          </div>
          <div className="border-t px-4 py-2.5 shrink-0 flex items-center justify-end gap-2">
            {done && <span className="mr-auto text-[11px] text-emerald-500 inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" /> published {done}</span>}
            <button type="button" onClick={close} className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:bg-accent cursor-pointer">{done ? 'Close' : 'Cancel'}</button>
            {!done && (
              <Button size="sm" disabled={!slug.trim() || !p || p.kept.length === 0 || publish.isPending}
                onClick={() => publish.mutate({ agentName, slug: slug.trim(), displayName: displayName.trim() || undefined, description: description.trim() || undefined })}>
                {publish.isPending ? 'publishing…' : 'Publish template'}
              </Button>
            )}
          </div>
        </>
      )}
    </Overlay>
  );
}
