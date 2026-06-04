'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { FileList, type FileItem } from '@/components/file-detail';

type Ref = { path: string; content: string };

// Read-only detail for a marketplace skill: version history + the selected
// version's SKILL.md + ref files. Bare createPortal modal (per the overlay
// gotcha — not base-ui Dialog), self-managed Esc + scroll-lock.
export function MarketSkillDetail({ slug, onClose }: { slug: string; onClose: () => void }) {
  const q = trpc.market.getSkill.useQuery({ slug });
  const skill = q.data;
  const versions = skill?.versions ?? [];
  const [selId, setSelId] = useState<string | null>(null);
  const selected = versions.find((v) => v.id === selId) ?? versions[0] ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const files: FileItem[] = selected
    ? [
        { key: 'SKILL.md', label: 'SKILL.md', body: selected.content ?? null, monoLabel: true },
        ...(((selected.refs as Ref[]) ?? []).map((r) => ({ key: r.path, label: r.path, body: r.content, monoLabel: true }))),
      ]
    : [];

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{skill?.displayName ?? slug}</div>
            <div className="text-[11px] font-mono text-muted-foreground/70 truncate">{slug}{skill ? ` · ${skill.origin}` : ''}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="close" className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-3">
          {q.isLoading && <div className="text-xs text-muted-foreground">loading…</div>}
          {!q.isLoading && !skill && <div className="text-xs text-muted-foreground">skill not found.</div>}
          {skill && (
            <>
              {skill.description && <p className="text-sm text-muted-foreground">{skill.description}</p>}
              <div className="space-y-1">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">Versions</div>
                <div className="flex flex-wrap gap-1.5">
                  {versions.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setSelId(v.id)}
                      title={v.changelog ?? undefined}
                      className={cn(
                        'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-mono cursor-pointer transition-colors',
                        selected?.id === v.id ? 'border-foreground/40 bg-accent text-foreground' : 'border-border text-muted-foreground hover:bg-accent/50',
                      )}
                    >
                      v{v.version} · {relTime(v.createdAt)}
                    </button>
                  ))}
                </div>
              </div>
              {selected?.changelog && <p className="text-xs text-muted-foreground/80 border-l-2 border-border pl-2">{selected.changelog}</p>}
              <FileList items={files} />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
