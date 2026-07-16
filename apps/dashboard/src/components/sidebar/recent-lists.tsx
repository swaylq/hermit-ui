'use client';

// Worker "recents" sidebar lists — the per-route lists at the bottom of the sidebar
// (Crons on /cron and Agents on /agents here; the /chat sessions to follow). Extracted
// verbatim from app-sidebar.tsx (P2-4); behaviour identical. This file is the home for
// the near-identical Recent* lists that P2-4's runtime-gated dedup will later fold into
// one parameterised unit. RecentCrons and RecentAgents are rendered by AppSidebar;
// fmtEvery is a private cron-interval formatter.

import { useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { SidebarFindInput } from '@/components/sidebar/sidebar-find-input';
import { TrashedAgents } from '@/components/sidebar/trashed-agents';

function fmtEvery(sec: number): string {
  if (sec % 3600 === 0) return `every ${sec / 3600}h`;
  if (sec % 60 === 0) return `every ${sec / 60}m`;
  return `every ${sec}s`;
}

// Cron list shown in the sidebar on /cron — all scheduled tasks across agents.
// Mirrors RecentSessions/RecentAgents so the chrome reads the same.
export function RecentCrons() {
  const search = useSearchParams();
  const activeId = search.get('id');
  const crons = trpc.cron.list.useQuery(undefined, { refetchInterval: 5_000 });
  // The orchestrator (Brain) lives only in /brain — keep its crons out of the
  // dashboard. agents.list is cached (shared), so this is cheap.
  const orchestratorsQ = trpc.agents.list.useQuery(undefined, { staleTime: 60_000 });
  const brainName = (orchestratorsQ.data ?? []).find((a) => a.isOrchestrator)?.name;
  const allCrons = (crons.data ?? []).filter((c) => c.agentName !== brainName);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const visible = needle
    ? allCrons.filter((c) => (c.title || c.prompt || '').toLowerCase().includes(needle) || c.agentName.toLowerCase().includes(needle))
    : allCrons;

  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>Crons</span>
        <span className="tabular-nums text-muted-foreground/50">{visible.length}</span>
      </div>
      {(crons.data?.length ?? 0) > 0 && (
        <SidebarFindInput value={q} onChange={setQ} placeholder="搜索 cron / agent" label="search crons by title or agent" />
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {crons.isPending ? (
          <div className="space-y-1 px-1 pt-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 rounded-md bg-sidebar-accent/40 animate-pulse" />
            ))}
          </div>
        ) : allCrons.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">no crons yet — start with “New cron”.</p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">没有匹配 “{q.trim()}” 的 cron。</p>
        ) : (
          <ul className="space-y-px">
            {visible.map((c) => {
              const active = activeId === c.id;
              const dot = !c.enabled
                ? 'border border-muted-foreground/40'
                : c.lastStatus === 'fail' || c.lastStatus === 'error'
                  ? 'bg-rose-500'
                  : c.lastStatus === 'running'
                    ? 'bg-amber-500'
                    : c.lastStatus === 'timeout' || c.lastStatus === 'no_output'
                      ? 'bg-amber-500' // inconclusive, not a failure
                      : 'bg-emerald-500';
              return (
                <li key={c.id}>
                  <Link
                    href={`/cron?id=${encodeURIComponent(c.id)}`}
                    className={cn(
                      'group block w-full rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors',
                      active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
                      !c.enabled && 'opacity-60',
                    )}
                    title={c.title || c.prompt}
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <span
                        className={cn('mt-1.5 h-1.5 w-1.5 rounded-full shrink-0', dot, c.lastStatus === 'running' && 'animate-pulse')}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-1.5">
                          <span className={cn('flex-1 truncate text-[13px]', active ? 'text-sidebar-foreground font-medium' : 'text-sidebar-foreground/85')}>
                            {c.title || c.prompt}
                          </span>
                          {c.unreadCount > 0 && (
                            <span
                              className="shrink-0 inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-mono tabular-nums leading-none"
                              title={`${c.unreadCount} 条未读执行`}
                            >
                              {c.unreadCount}
                            </span>
                          )}
                          <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                            {relTime(c.lastFire ?? c.createdAt)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/75 tabular-nums truncate">
                          <span className="truncate">{c.agentName}</span>
                          <span className="text-muted-foreground/40">·</span>
                          <span>{fmtEvery(c.intervalSec)}</span>
                        </div>
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// Agent list shown in the sidebar on /agents. Mirrors RecentSessions visually
// so the two routes feel like the same chrome with a different payload.
export function RecentAgents() {
  const search = useSearchParams();
  const activeName = search.get('name');
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 10_000 });
  const pending = trpc.agents.pendingRequests.useQuery(undefined, {
    // Fast only while something is in flight; idle backs off hard (create/delete
    // already invalidate this, so a fresh pending shows at once). Both observers
    // of this query (here + /agents page) must agree — RQ uses the min interval.
    refetchInterval: (q) => (((q.state.data as unknown[] | undefined)?.length ?? 0) > 0 ? 2_000 : 12_000),
  });
  const utils = trpc.useUtils();

  // Prefetch an agent's full detail on hover/focus (intent to open) so the click
  // is instant. This REPLACED eagerly prefetching the top-20 agents' byName
  // (~50-70KB each) on load AND re-firing every 30s — hundreds of KB up front for
  // agents the user never opens (measured: 4 agents = 229KB at open, dominant
  // cost once folders went lazy). staleTime dedupes repeat hovers.
  const prefetchAgent = useCallback(
    (name: string) => {
      void utils.agents.byName.prefetch({ name }, { staleTime: 30_000 });
    },
    [utils],
  );

  const pendingAdds = (pending.data ?? []).filter((p) => p.kind === 'create' || p.kind === 'import');
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  // The orchestrator (义脑) lives in its own /brain panel, not the worker list.
  const workers = (agents.data ?? []).filter((a) => !a.isOrchestrator);
  const visible = needle ? workers.filter((a) => a.name.toLowerCase().includes(needle)) : workers;

  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>Agents</span>
        <span className="tabular-nums text-muted-foreground/50">{visible.length}</span>
      </div>
      {(agents.data?.length ?? 0) > 0 && (
        <SidebarFindInput value={q} onChange={setQ} placeholder="搜索 agent" label="search agents by name" />
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {agents.isPending ? (
          <div className="space-y-1 px-1 pt-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 rounded-md bg-sidebar-accent/40 animate-pulse" />
            ))}
          </div>
        ) : workers.length === 0 && pendingAdds.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">no agents yet — start with “New agent”.</p>
        ) : visible.length === 0 && pendingAdds.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">没有匹配 “{q.trim()}” 的 agent。</p>
        ) : (
          <ul className="space-y-px">
            {visible.map((a) => {
              const active = activeName === a.name;
              return (
                <li key={a.id}>
                  <Link
                    href={`/agents?name=${encodeURIComponent(a.name)}`}
                    onMouseEnter={() => prefetchAgent(a.name)}
                    onFocus={() => prefetchAgent(a.name)}
                    className={cn(
                      'group block w-full rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors',
                      active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
                    )}
                    title={a.name}
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <span
                        className={cn(
                          'mt-1.5 h-1.5 w-1.5 rounded-full shrink-0',
                          a.activeSessionCount > 0 ? 'bg-emerald-500' : 'border border-muted-foreground/40',
                        )}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-1.5">
                          <span className={cn(
                            'flex-1 truncate text-[13px] font-mono',
                            active ? 'text-sidebar-foreground font-medium' : 'text-sidebar-foreground/85',
                          )}>
                            {a.name}
                          </span>
                          {a.metadataAt && (
                            <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                              {relTime(a.metadataAt)}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/75 tabular-nums">
                          {a.activeSessionCount > 0 ? (
                            <span className="text-emerald-600">{a.activeSessionCount} active</span>
                          ) : (
                            <span>{a.sessionCount} session{a.sessionCount === 1 ? '' : 's'}</span>
                          )}
                          <span className="text-muted-foreground/40">·</span>
                          <span>{a.skillCount} skill{a.skillCount === 1 ? '' : 's'}</span>
                        </div>
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
            {pendingAdds.map((p) => (
              <li key={p.id} className="px-2.5 py-1.5 opacity-70">
                <div className="flex items-start gap-2 min-w-0">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 border border-muted-foreground/40" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-1.5">
                      <span className="flex-1 truncate text-[13px] font-mono text-sidebar-foreground/70">{p.agentName}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/60 animate-pulse">
                        {p.kind === 'import' ? 'importing…' : 'creating…'}
                      </span>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <TrashedAgents />
    </div>
  );
}
