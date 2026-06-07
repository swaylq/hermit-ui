'use client';

import { useState } from 'react';
import { Search, X, Check, Download } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { pollInvalidate } from '@/lib/poll-invalidate';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Overlay } from '@/components/overlay';

// Pick a marketplace skill and install it into an agent / this machine
// (installToAgent / installToMachine → AgentRequest(edit) / GlobalSkillRequest).
// The install entry point lives on the managing surface (agent detail, /skills) —
// the market page itself is browse-only. Omit agentName for machine install.
export function InstallSkillDialog({
  agentName, installedNames, onClose,
}: {
  agentName?: string;
  installedNames: string[];
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [q, setQ] = useState('');
  const skills = trpc.market.listSkills.useQuery({ q: q.trim() || undefined });
  const [doneSlug, setDoneSlug] = useState<string | null>(null);
  const installA = trpc.market.installToAgent.useMutation({
    onSuccess: (_r, vars) => {
      pollInvalidate(() => {
        utils.market.agentSkillStatus.invalidate({ agentName: agentName! });
        utils.agents.byName.invalidate({ name: agentName! });
      });
      setDoneSlug(vars.slug);
    },
  });
  const installM = trpc.market.installToMachine.useMutation({
    onSuccess: (_r, vars) => {
      pollInvalidate(() => {
        utils.market.globalSkillStatus.invalidate();
        utils.skills.list.invalidate();
      });
      setDoneSlug(vars.slug);
    },
  });
  const install = agentName ? installA : installM;
  const doInstall = (slug: string) => { if (agentName) installA.mutate({ slug, agentName }); else installM.mutate({ slug }); };
  const installedSet = new Set(installedNames);

  return (
    <Overlay onClose={onClose} panelClassName="w-full max-w-lg max-h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl">
      {(close) => (
        <>
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 shrink-0">
            <span className="text-sm font-medium">Install skill {agentName ? `→ ${agentName}` : '→ this machine'}</span>
            <button type="button" onClick={close} aria-label="close" className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent cursor-pointer">
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
                    onClick={() => doInstall(s.slug)}
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
        </>
      )}
    </Overlay>
  );
}
