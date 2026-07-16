'use client';

import { useState } from 'react';
import { Download, Pencil, Trash2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { authedFetch } from '@/lib/asst-fetch';
import { type FileItem } from '@/components/file-detail';
import { SkillDiff } from '@/components/skill-diff';
import { SkillFilesModal } from '@/components/skill-files-modal';
import { useConfirm } from '@/components/ui/confirm-dialog';

type Ref = { path?: string; name?: string; content: string };

// Read-only detail for a marketplace skill: version history + the selected
// version's SKILL.md + ref files. Renders through the shared SkillFilesModal so
// it matches the agent detail's skill popup; the version selector / diff toggle
// ride in `headerExtra`, and the diff replaces the file list via `body`.
export function MarketSkillDetail({ slug, onClose }: { slug: string; onClose: () => void }) {
  const q = trpc.market.getSkill.useQuery({ slug });
  const skill = q.data;
  const versions = skill?.versions ?? [];
  const [selId, setSelId] = useState<string | null>(null);
  const [view, setView] = useState<'content' | 'diff'>('content');
  const selected = versions.find((v) => v.id === selId) ?? versions[0] ?? null;
  // versions are newest-first, so the predecessor (for the diff) sits at +1.
  const curIdx = selected ? versions.findIndex((v) => v.id === selected.id) : -1;
  const previous = curIdx >= 0 ? versions[curIdx + 1] ?? null : null;

  const [downloading, setDownloading] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);
  // Inline group editor — set/clear/create a skill's group right here so existing
  // skills can be grouped without re-publishing. A Select dropdown (matches the
  // market filter) lists existing groups + 未分组 (clear) + ＋ 新建分组…; picking
  // "new" flips `newGroup` to a string and shows a text input to name it.
  const utils = trpc.useUtils();
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const allSkills = trpc.market.listSkills.useQuery({});
  const groupOptions = [...new Set((allSkills.data ?? []).map((s) => s.category).filter((c): c is string => !!c))].sort();
  const setCat = trpc.market.setSkillCategory.useMutation({
    onSuccess: () => {
      utils.market.getSkill.invalidate({ slug });
      utils.market.listSkills.invalidate();
      setNewGroup(null);
    },
  });
  // Inline display-name editor — rename the skill's human-visible title in place
  // (pure market metadata; doesn't touch slug / the on-disk dir / installed copies).
  // Same shape as the group editor above; the modal title + list card both refresh
  // off the two invalidations.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const rename = trpc.market.setSkillDisplayName.useMutation({
    onSuccess: () => {
      utils.market.getSkill.invalidate({ slug });
      utils.market.listSkills.invalidate();
      setEditingName(false);
    },
  });
  function saveName() {
    const n = nameDraft.trim();
    if (n && skill && n !== skill.displayName) rename.mutate({ slug, displayName: n });
    else setEditingName(false);
  }
  // Delete this skill from the market (registry row + all versions). Guarded by a
  // confirm; installed on-disk copies are left untouched (see deleteSkill). On
  // success the card leaves the grid (listSkills) and the modal closes.
  const confirm = useConfirm();
  const del = trpc.market.deleteSkill.useMutation({
    onSuccess: () => {
      utils.market.listSkills.invalidate();
      onClose();
    },
  });
  async function handleDelete() {
    if (
      await confirm({
        title: 'Delete skill',
        message: `Delete “${skill?.displayName ?? slug}” (${slug}) and all its versions from the market? Copies already installed on agents or machines stay on disk. This can’t be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      })
    )
      del.mutate({ slug });
  }
  // Download the selected version as a .zip. A plain <a download> can't carry
  // the x-asst-key header, so fetch with the key → blob → synthetic anchor.
  async function download() {
    if (!selected) return;
    setDownloading(true);
    setDlError(null);
    try {
      const res = await authedFetch(
        `/api/market/skills/${encodeURIComponent(slug)}/download?version=${encodeURIComponent(selected.version)}`,
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setDlError(j?.error || `download failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}-v${selected.version}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDlError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

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

  const headerExtra = (
    <>
      {q.isLoading && <div className="text-xs text-muted-foreground">loading…</div>}
      {!q.isLoading && !skill && <div className="text-xs text-muted-foreground">skill not found.</div>}
      {skill && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline" disabled={!selected || downloading} onClick={download}>
              <Download className="h-3.5 w-3.5 mr-1" /> {downloading ? '打包中…' : `Download v${selected?.version ?? ''} .zip`}
            </Button>
            {dlError && <span className="text-xs text-rose-500">{dlError}</span>}
            <Button size="sm" variant="destructive" className="ml-auto" disabled={del.isPending} onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5 mr-1" /> {del.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
          {del.isError && <span className="text-xs text-rose-500">{del.error.message}</span>}
          {skill.description && <p className="text-sm text-muted-foreground">{skill.description}</p>}
          <div className="flex items-center gap-2 text-xs">
            <span className="shrink-0 text-muted-foreground/70">Display name</span>
            {editingName ? (
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName();
                  if (e.key === 'Escape') setEditingName(false);
                }}
                onBlur={saveName}
                maxLength={100}
                placeholder="Display name — Enter to save, Esc to cancel"
                className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 outline-none transition-colors focus:border-foreground/30"
              />
            ) : (
              <>
                <span className="min-w-0 truncate font-medium text-foreground">{skill.displayName}</span>
                <button
                  type="button"
                  onClick={() => { setNameDraft(skill.displayName); setEditingName(true); }}
                  aria-label="Rename skill"
                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            {rename.isPending && <span className="shrink-0 text-muted-foreground">Saving…</span>}
            {rename.isError && <span className="shrink-0 text-rose-500">{rename.error.message}</span>}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="shrink-0 text-muted-foreground/70">分组 Group</span>
            {newGroup === null ? (
              <Select
                value={skill.category ?? ''}
                onValueChange={(v) => {
                  if (v == null) return;
                  if (v === '__new__') { setNewGroup(''); return; }
                  if ((v || null) !== (skill.category ?? null)) setCat.mutate({ slug, category: v || null });
                }}
                modal={false}
              >
                <SelectTrigger aria-label="设置分组" className="h-7 w-auto min-w-[8rem] font-mono">
                  <SelectValue>{(v: string | null) => (v ? v : '未分组')}</SelectValue>
                </SelectTrigger>
                <SelectContent className="font-mono">
                  <SelectItem value="">未分组</SelectItem>
                  {groupOptions.map((g) => (
                    <SelectItem key={g} value={g}>{g}</SelectItem>
                  ))}
                  <SelectItem value="__new__">+ New group…</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <input
                autoFocus
                value={newGroup}
                onChange={(e) => setNewGroup(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { const n = newGroup.trim(); if (n) setCat.mutate({ slug, category: n }); else setNewGroup(null); }
                  if (e.key === 'Escape') setNewGroup(null);
                }}
                onBlur={() => { const n = newGroup.trim(); if (n && n !== (skill.category ?? '')) setCat.mutate({ slug, category: n }); else setNewGroup(null); }}
                placeholder="New group name — Enter to save, Esc to cancel"
                className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 outline-none transition-colors focus:border-foreground/30"
              />
            )}
            {setCat.isPending && <span className="shrink-0 text-muted-foreground">保存中…</span>}
            {setCat.isError && <span className="shrink-0 text-rose-500">{setCat.error.message}</span>}
          </div>
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
        </>
      )}
    </>
  );

  const diffBody =
    view === 'diff'
      ? previous && selected
        ? <SkillDiff oldText={previous.content ?? ''} newText={selected.content ?? ''} />
        : <div className="text-xs text-muted-foreground px-1 py-2">v{selected?.version} 是最早的版本，没有可对比的上一版。</div>
      : undefined;

  return (
    <SkillFilesModal
      title={skill?.displayName ?? slug}
      subtitle={`${slug}${skill ? ` · ${skill.origin}` : ''}`}
      headerExtra={headerExtra}
      items={files}
      body={diffBody}
      onClose={onClose}
    />
  );
}
