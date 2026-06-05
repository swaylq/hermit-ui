'use client';

import { useState } from 'react';
import { Upload, X, Check } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Overlay } from '@/components/overlay';

// Publishes a local skill into the fleet marketplace. Lives wherever a skill
// lives — the /skills detail header (source: 'global') and the agent-detail
// skill rows (source: 'agent'). Backend: market.publishSkillFromLocal.
export function PublishToMarketButton({
  source, skillName, agentName, className,
}: {
  source: 'global' | 'agent';
  skillName: string;
  agentName?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        className={className ?? 'shrink-0 text-muted-foreground hover:text-foreground'}
        title="Publish to market"
        aria-label="publish to market"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >
        <Upload className="size-3.5" />
      </Button>
      {open && <PublishDialog source={source} skillName={skillName} agentName={agentName} onClose={() => setOpen(false)} />}
    </>
  );
}

function PublishDialog({
  source, skillName, agentName, onClose,
}: {
  source: 'global' | 'agent';
  skillName: string;
  agentName?: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [changelog, setChangelog] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const publish = trpc.market.publishSkillFromLocal.useMutation({
    onSuccess: (row) => { utils.market.listSkills.invalidate(); setDone(`${row.slug} · v${row.latestVersion}`); },
    onError: (e) => setErr(e.message),
  });

  return (
    <Overlay onClose={onClose} panelClassName="w-full max-w-sm rounded-lg border border-border bg-background shadow-xl">
      {(close) => (
        <>
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="text-sm font-medium truncate">Publish to market</span>
            <button type="button" onClick={close} aria-label="close" className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent cursor-pointer">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              发布 <span className="font-mono text-foreground/90">{skillName}</span>
              {source === 'agent' && agentName ? <> （来自 agent <span className="font-mono text-foreground/90">{agentName}</span>）</> : <>（本机 skill）</>}
              {' '}到舰队公共市场。已存在则追加一个新版本。
            </p>
            {done ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5 shrink-0" /> 已发布 <span className="font-mono">{done}</span>
              </div>
            ) : (
              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Changelog <span className="opacity-50">(optional)</span></span>
                <Input value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="what changed" className="mt-1.5 text-sm" />
              </label>
            )}
            {err && <p className="text-xs text-rose-500">{err}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={close} className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:bg-accent cursor-pointer">
                {done ? 'Close' : 'Cancel'}
              </button>
              {!done && (
                <Button
                  size="sm"
                  disabled={publish.isPending}
                  onClick={() => publish.mutate({ source, skillName, agentName, changelog: changelog.trim() || undefined })}
                >
                  {publish.isPending ? 'publishing…' : 'Publish'}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </Overlay>
  );
}
