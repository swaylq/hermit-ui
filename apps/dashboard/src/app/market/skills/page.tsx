'use client';

import { useMemo, useState } from 'react';
import { Boxes, Search, Plus, Upload } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { MarketSkillDetail } from '@/components/market-skill-detail';
import { CategoryChips } from '@/components/category-chips';
import { ImportSkillDialog } from '@/components/import-skill-dialog';
import { UploadSkillDialog } from '@/components/upload-skill-dialog';

function OriginBadge({ origin }: { origin: string }) {
  const map: Record<string, string> = {
    uploaded: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/25',
    github: 'text-sky-500 bg-sky-500/10 border-sky-500/25',
    'master-skill.org': 'text-amber-500 bg-amber-500/10 border-amber-500/25',
    manual: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/25',
  };
  const label = origin === 'master-skill.org' ? 'master.skill' : origin;
  return <span className={cn('inline-flex items-center rounded border px-1.5 py-px text-[10px] font-mono', map[origin] ?? map.manual)}>{label}</span>;
}

export default function MarketSkillsPage() {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [cat, setCat] = useState('');
  const skills = trpc.market.listSkills.useQuery({ q: q.trim() || undefined }, { refetchInterval: 15_000 });
  // Group filter is client-side over the search result so the chip row always
  // shows every group present in the current search (a server-side category param
  // would collapse the chips down to the one you picked).
  const cats = useMemo(
    () => [...new Set((skills.data ?? []).map((s) => s.category).filter((c): c is string => !!c))].sort(),
    [skills.data],
  );
  const shown = (skills.data ?? []).filter((s) => !cat || s.category === cat);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="border-b border-border px-4 h-12 flex items-center gap-2 shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-semibold text-foreground">Marketplace · Skills</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative hidden sm:block">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search skills" className="h-8 w-48 pl-7 text-sm" />
          </div>
          <Button size="sm" onClick={() => setImportOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Import
          </Button>
          <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
            <Upload className="h-3.5 w-3.5 mr-1" /> Upload .zip
          </Button>
        </div>
      </header>

      {cats.length > 0 && (
        <div className="border-b border-border px-4 py-2 shrink-0">
          <CategoryChips cats={cats} value={cat} onChange={setCat} />
        </div>
      )}

      <ScrollArea className="flex-1 min-h-0 bg-background">
        <div className="p-4">
          {shown.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-20 text-muted-foreground">
              <Boxes className="h-10 w-10 mb-3 opacity-30" aria-hidden="true" />
              {(skills.data?.length ?? 0) === 0 ? (
                <>
                  <p className="text-sm">市场还没有 skill。</p>
                  <p className="mt-1 text-xs">点上方 <b>Import</b> 从 URL(master.skill / GitHub)导入、<b>Upload .zip</b> 上传压缩包,或在 Skills 页 / agent 详情点 skill 的「上传」发布到这里。</p>
                </>
              ) : (
                <p className="text-sm">「{cat}」分组下还没有 skill。</p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {shown.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelected(s.slug)}
                  className="text-left rounded-lg border bg-card hover:bg-accent/40 hover:border-foreground/30 transition-colors p-3 flex flex-col gap-1.5 cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">{s.displayName}</span>
                    <span className="shrink-0 text-[11px] font-mono text-muted-foreground/70">v{s.latestVersion}</span>
                  </div>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[11px] font-mono text-muted-foreground/60 truncate">{s.slug}</span>
                    <OriginBadge origin={s.origin} />
                    {s.category && <span className="shrink-0 inline-flex items-center rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">{s.category}</span>}
                  </div>
                  {s.description && <p className="text-xs text-muted-foreground line-clamp-2">{s.description}</p>}
                  <span className="text-[10px] text-muted-foreground/50 mt-auto pt-1">updated {relTime(s.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      {selected && <MarketSkillDetail slug={selected} onClose={() => setSelected(null)} />}
      {importOpen && <ImportSkillDialog onClose={() => setImportOpen(false)} />}
      {uploadOpen && <UploadSkillDialog onClose={() => setUploadOpen(false)} />}
    </div>
  );
}
