'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Boxes, Search, Upload, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { MarketSkillDetail } from '@/components/market-skill-detail';

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
  const [publishOpen, setPublishOpen] = useState(false);
  const skills = trpc.market.listSkills.useQuery({ q: q.trim() || undefined }, { refetchInterval: 15_000 });

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
          <Button size="sm" onClick={() => setPublishOpen(true)}>
            <Upload className="h-3.5 w-3.5 mr-1" /> Publish
          </Button>
        </div>
      </header>

      <ScrollArea className="flex-1 min-h-0 bg-background">
        <div className="p-4">
          {(skills.data?.length ?? 0) === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-20 text-muted-foreground">
              <Boxes className="h-10 w-10 mb-3 opacity-30" aria-hidden="true" />
              <p className="text-sm">市场还没有 skill。</p>
              <p className="mt-1 text-xs">点 <b>Publish</b> 把本机的一个 skill 发布上来,或等 C 阶段从 URL 导入。</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {skills.data!.map((s) => (
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
      {publishOpen && <PublishDialog onClose={() => setPublishOpen(false)} />}
    </div>
  );
}

// Seed/publish path: pick one of this machine's GlobalSkills and publish it into
// the fleet market (Phase A's only write path — makes the market testable).
function PublishDialog({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const local = trpc.market.localSkills.useQuery();
  const [skillName, setSkillName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [changelog, setChangelog] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const publish = trpc.market.publishSkillFromLocal.useMutation({
    onSuccess: () => { utils.market.listSkills.invalidate(); onClose(); },
    onError: (e) => setErr(e.message),
  });
  const picked = local.data?.find((s) => s.name === skillName);
  const canSubmit = !!skillName && !picked?.isBundle && !publish.isPending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="text-sm font-medium">Publish a local skill</span>
          <button type="button" onClick={onClose} aria-label="close" className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Machine skill</span>
            <select
              value={skillName}
              onChange={(e) => { setSkillName(e.target.value); setErr(null); }}
              className="mt-1.5 w-full h-9 rounded-md border border-border bg-background px-2 text-sm cursor-pointer"
            >
              <option value="">— pick a skill —</option>
              {(local.data ?? []).map((s) => (
                <option key={s.name} value={s.name} disabled={s.isBundle}>
                  {s.name}{s.isBundle ? ' (bundle — 不支持)' : ''}
                </option>
              ))}
            </select>
            {picked?.isBundle && <span className="text-[10px] text-amber-500">bundle 无单文件内容,A 阶段先发普通 skill。</span>}
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Display name <span className="opacity-50">(optional)</span></span>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={skillName || 'skill name'} className="mt-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Changelog <span className="opacity-50">(optional)</span></span>
            <Input value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="what changed" className="mt-1.5 text-sm" />
          </label>
          {err && <p className="text-xs text-rose-500">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:bg-accent cursor-pointer">Cancel</button>
            <Button
              size="sm"
              disabled={!canSubmit}
              onClick={() => publish.mutate({ source: 'global', skillName, displayName: displayName.trim() || undefined, changelog: changelog.trim() || undefined })}
            >
              {publish.isPending ? 'publishing…' : 'Publish'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
