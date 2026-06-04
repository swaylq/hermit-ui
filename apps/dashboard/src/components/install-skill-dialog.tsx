'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Check, Download } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// Pick a marketplace skill and install it into an agent (installToAgent →
// AgentRequest(edit, skill:<slug>); binds via AgentSkillInstall). The install
// entry point lives here, on the agent — the market page itself is browse-only.
export function InstallSkillDialog({
  agentName, installedNames, onClose,
}: {
  agentName: string;
  installedNames: string[];
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [q, setQ] = useState('');
  const skills = trpc.market.listSkills.useQuery({ q: q.trim() || undefined });
  const [doneSlug, setDoneSlug] = useState<string | null>(null);
  const install = trpc.market.installToAgent.useMutation({
    onSuccess: (_r, vars) => {
      utils.market.agentSkillStatus.invalidate({ agentName });
      utils.agents.byName.invalidate({ name: agentName });
      setDoneSlug(vars.slug);
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const installedSet = new Set(installedNames);

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 shrink-0">
          <span className="text-sm font-medium">Install skill from market</span>
          <button type="button" onClick={onClose} aria-label="close" className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-4 py-2 border-b shrink-0">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search market skills" className="h-8 pl-7 text-sm" />
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-1.5">
          {skills.isLoading && <div className="text-xs text-muted-foreground">loading…</div>}
          {!skills.isLoading && (skills.data?.length ?? 0) === 0 && (
            <div className="text-xs text-muted-foreground">market 里还没有 skill。先在某个 skill 上点「上传」发布一个。</div>
          )}
          {skills.data?.map((s) => {
            const already = installedSet.has(s.slug);
            const justDone = doneSlug === s.slug;
            return (
              <div key={s.id} className="flex items-center justify-between gap-2 rounded border bg-card px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{s.displayName}</div>
                  <div className="text-[11px] font-mono text-muted-foreground/60 truncate">{s.slug} · v{s.latestVersion}</div>
                </div>
                <Button
                  size="sm"
                  variant={already && !justDone ? 'ghost' : undefined}
                  disabled={install.isPending}
                  onClick={() => install.mutate({ slug: s.slug, agentName })}
                >
                  {justDone ? <><Check className="h-3.5 w-3.5 mr-1" /> installed</>
                    : already ? 'reinstall'
                    : <><Download className="h-3.5 w-3.5 mr-1" /> install</>}
                </Button>
              </div>
            );
          })}
          {install.error && <div className="text-[11px] text-rose-500">{install.error.message}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
