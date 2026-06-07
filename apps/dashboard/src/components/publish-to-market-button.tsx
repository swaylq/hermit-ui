'use client';

import { useState } from 'react';
import { Upload, X, Check, Loader2 } from 'lucide-react';
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
  // Gate publishing while this skill has an un-synced local edit in flight. The
  // publish reads the DB-cached skill body, which only refreshes after the
  // gateway applies the edit and re-syncs; publishing mid-sync reads stale
  // content → a silent no-op re-publish. The per-skill request queue is the
  // signal: a pending edit means the new content hasn't landed yet. One shared
  // poll per page (React Query dedupes the no-arg query across every button).
  const agentPending = trpc.agents.pendingRequests.useQuery(undefined, {
    enabled: source === 'agent', refetchInterval: 3000,
  });
  const globalPending = trpc.skills.pendingRequests.useQuery(undefined, {
    enabled: source === 'global', refetchInterval: 3000,
  });
  const syncing = source === 'agent'
    ? (agentPending.data ?? []).some((r) => r.kind === 'edit' && r.agentName === agentName && r.target === `skill:${skillName}`)
    : (globalPending.data ?? []).some((r) => r.skillName === skillName);

  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        className={className ?? 'shrink-0 text-muted-foreground hover:text-foreground'}
        title={syncing ? '改动同步中…同步完成后即可发布' : 'Publish to market'}
        aria-label="publish to market"
        disabled={syncing}
        onClick={(e) => { e.stopPropagation(); if (!syncing) setOpen(true); }}
      >
        {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
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
  const [done, setDone] = useState<{ label: string; created: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const publish = trpc.market.publishSkillFromLocal.useMutation({
    onSuccess: (row) => {
      utils.market.listSkills.invalidate();
      // Publishing also creates/updates the binding — refresh the linked-state
      // queries so the 🔗 chip appears now, not after the next 30s status poll.
      if (source === 'agent' && agentName) utils.market.agentSkillStatus.invalidate({ agentName });
      else if (source === 'global') utils.market.globalSkillStatus.invalidate();
      setDone({ label: `${row.slug} · v${row.latestVersion}`, created: row.created });
    },
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
            {done?.created ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5 shrink-0" /> 已发布 <span className="font-mono">{done.label}</span>
              </div>
            ) : (
              <>
                {done && !done.created && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    内容与 <span className="font-mono">{done.label}</span> 相同，未创建新版本。
                    <span className="mt-1 block opacity-80">刚改过这个 skill 的话，改动可能还没同步到面板（约几秒）——稍候再点一次「重新发布」。</span>
                  </div>
                )}
                <label className="block">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Changelog <span className="opacity-50">(optional)</span></span>
                  <Input value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="what changed" className="mt-1.5 text-sm" />
                </label>
              </>
            )}
            {err && <p className="text-xs text-rose-500">{err}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={close} className="h-8 px-3 rounded-md text-sm text-muted-foreground hover:bg-accent cursor-pointer">
                {done?.created ? 'Close' : 'Cancel'}
              </button>
              {!done?.created && (
                <Button
                  size="sm"
                  disabled={publish.isPending}
                  onClick={() => publish.mutate({ source, skillName, agentName, changelog: changelog.trim() || undefined })}
                >
                  {publish.isPending ? 'publishing…' : (done ? '重新发布' : 'Publish')}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </Overlay>
  );
}
