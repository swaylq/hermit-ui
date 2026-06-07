'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { FileList, type FileItem } from '@/components/file-detail';
import { SkillDiff } from '@/components/skill-diff';
import { Overlay } from '@/components/overlay';

type Ref = { path?: string; name?: string; content: string };

// Read-only detail for a marketplace skill: version history + the selected
// version's SKILL.md + ref files.
export function MarketSkillDetail({ slug, onClose }: { slug: string; onClose: () => void }) {
  const q = trpc.market.getSkill.useQuery({ slug });
  const skill = q.data;
  const versions = skill?.versions ?? [];
  const [selId, setSelId] = useState<string | null>(null);
  const [view, setView] = useState<'content' | 'diff'>('content');
  const selected = versions.find((v) => v.id === selId) ?? versions[0] ?? null;
  // The chronologically previous (older) version, for the diff. versions are
  // newest-first, so the predecessor sits at the next index.
  const curIdx = selected ? versions.findIndex((v) => v.id === selected.id) : -1;
  const previous = curIdx >= 0 ? versions[curIdx + 1] ?? null : null;

  const files: FileItem[] = selected
    ? [
        { key: 'SKILL.md', label: 'SKILL.md', body: selected.content ?? null, monoLabel: true },
        ...(((selected.refs as Ref[]) ?? []).map((r, i) => {
          // Older global-skill publishes stored refs as { name } not { path };
          // fall back so every file shows a name (and a stable React key).
          const label = r.path ?? r.name ?? `(file ${i + 1})`;
          return { key: `${label}-${i}`, label, body: r.content, monoLabel: true };
        })),
      ]
    : [];

  return (
    <Overlay onClose={onClose} z={100} panelClassName="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl">
      {(close) => (
        <>
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 shrink-0">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{skill?.displayName ?? slug}</div>
              <div className="text-[11px] font-mono text-muted-foreground/70 truncate">{slug}{skill ? ` · ${skill.origin}` : ''}</div>
            </div>
            <button type="button" onClick={close} aria-label="close" className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer shrink-0">
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
                {versions.length > 1 && (
                  <div className="flex items-center gap-1 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setView('content')}
                      className={cn('px-2 py-0.5 rounded cursor-pointer transition-colors', view === 'content' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50')}
                    >
                      内容
                    </button>
                    <button
                      type="button"
                      onClick={() => setView('diff')}
                      disabled={!previous}
                      title={previous ? undefined : '最早的版本，无可对比的上一版'}
                      className={cn('px-2 py-0.5 rounded transition-colors', view === 'diff' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50', previous ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed')}
                    >
                      改动{previous ? ` (vs v${previous.version})` : ''}
                    </button>
                  </div>
                )}
                {view === 'diff' ? (
                  previous && selected ? (
                    <SkillDiff oldText={previous.content ?? ''} newText={selected.content ?? ''} />
                  ) : (
                    <div className="text-xs text-muted-foreground px-1 py-2">v{selected?.version} 是最早的版本，没有可对比的上一版。</div>
                  )
                ) : (
                  <FileList items={files} />
                )}
              </>
            )}
          </div>
        </>
      )}
    </Overlay>
  );
}
