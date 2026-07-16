'use client';

// Worker "recents" sidebar lists — the per-route lists at the bottom of the sidebar
// (Crons on /cron, Agents on /agents, and Sessions on /chat). Extracted verbatim from
// app-sidebar.tsx (P2-4); behaviour identical. All three near-identical worker Recent*
// lists now live here so P2-4's runtime-gated dedup can fold them into one parameterised
// unit within a single file. RecentCrons/RecentAgents/RecentSessions are rendered by
// AppSidebar; fmtEvery is a private cron-interval formatter.
//
// Each row is a memo() component (CronRow/AgentRow/SessionRow) fed only stable props
// (the row object — referentially stable across a no-op poll via React Query's
// structural sharing — plus primitives and stable useCallbacks), so unchanged rows bail
// on every 5s poll instead of re-running their render body (sessionStatusView / relTime /
// cn / cronStatusTone) for all ~60 rows. Per-row handlers are created INSIDE the memo'd
// row (from stable callback props), which doesn't defeat its memo (P1-3, finding C2).

import { useState, useCallback, useMemo, useEffect, memo } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Trash2, RotateCw, FoldVertical, X, Search, Pin, Eye, EyeOff, Moon } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { sessionStatusView } from '@/lib/session-status';
import { isSessionUnread } from '@/lib/session-read';
import { useLiveWorking } from '@/lib/session-live';
import { usePins, togglePin } from '@/lib/session-pins';
import { useLongPress } from '@/lib/use-long-press';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { ContextMenu } from '@/components/ui/context-menu';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { SidebarFindInput } from '@/components/sidebar/sidebar-find-input';
import { TrashedAgents } from '@/components/sidebar/trashed-agents';
import { cronStatusTone, type CronStatusTone } from '@/lib/cron-status';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type CronListItem = RouterOutputs['cron']['list'][number];
type AgentListItem = RouterOutputs['agents']['list'][number];
type SessionListItem = RouterOutputs['chat']['listSessions'][number];

function fmtEvery(sec: number): string {
  if (sec % 3600 === 0) return `every ${sec / 3600}h`;
  if (sec % 60 === 0) return `every ${sec / 60}m`;
  return `every ${sec}s`;
}

// tone → cron dot bg (this site's own visual map; the status→tone grouping is shared).
// Note: an unknown/ok status both render emerald here (matches the prior fall-through).
const SIDEBAR_DOT_CLS: Record<CronStatusTone, string> = {
  ok: 'bg-emerald-500',
  bad: 'bg-rose-500',
  inconclusive: 'bg-amber-500',
  neutral: 'bg-emerald-500',
};

// One cron row. memo'd: `cron` is stable across a no-op poll (RQ structural sharing)
// and `active` is a primitive, so an unchanged row bails.
const CronRow = memo(function CronRow({ cron: c, active }: { cron: CronListItem; active: boolean }) {
  const dot = !c.enabled ? 'border border-muted-foreground/40' : SIDEBAR_DOT_CLS[cronStatusTone(c.lastStatus)];
  return (
    <li>
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
});

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
            {visible.map((c) => (
              <CronRow key={c.id} cron={c} active={activeId === c.id} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// One agent row. memo'd: `agent` is stable across a no-op poll, `active` is a
// primitive, and `onPrefetch` is a stable useCallback → unchanged rows bail.
const AgentRow = memo(function AgentRow({
  agent: a,
  active,
  onPrefetch,
}: {
  agent: AgentListItem;
  active: boolean;
  onPrefetch: (name: string) => void;
}) {
  return (
    <li>
      <Link
        href={`/agents?name=${encodeURIComponent(a.name)}`}
        onMouseEnter={() => onPrefetch(a.name)}
        onFocus={() => onPrefetch(a.name)}
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
});

// Agent list shown in the sidebar on /agents. Mirrors RecentSessions visually
// so the two routes feel like the same chrome with a different payload.
export function RecentAgents() {
  const search = useSearchParams();
  const activeName = search.get('name');
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 30_000 });
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
            {visible.map((a) => (
              <AgentRow key={a.id} agent={a} active={activeName === a.name} onPrefetch={prefetchAgent} />
            ))}
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

// One session row. memo'd: `session` is stable across a no-op poll (RQ structural
// sharing), `active`/`liveAt`/`pinned` are primitives, and onPrefetch/onOpenMenu/
// longPress are stable, so an unchanged row bails. The optimistic-working / unread /
// status derivation runs INSIDE the row (only when it re-renders), and the per-row
// handlers are built here from the stable callbacks — neither defeats the memo.
const SessionRow = memo(function SessionRow({
  session: s,
  active,
  liveAt,
  pinned,
  onPrefetch,
  onOpenMenu,
  longPress,
}: {
  session: SessionListItem;
  active: boolean;
  liveAt: number | null;
  pinned: boolean;
  onPrefetch: (id: string) => void;
  onOpenMenu: (id: string, x: number, y: number) => void;
  longPress: ReturnType<typeof useLongPress>;
}) {
  // Optimistic working: the moment the user sends, the session is marked live
  // (markSessionWorking) so this dot turns yellow instantly — no waiting ~13s for
  // the gateway snapshot + 5s poll. Reconcile with the gateway's truth: once it
  // snapshots the pane AFTER the send (snapshotAt > stamp), drop the optimism and
  // let the real `state` drive the dot.
  const optimisticWorking = liveAt != null && (!s.snapshotAt || new Date(s.snapshotAt).getTime() < liveAt);
  const status = sessionStatusView(s, {
    unread: isSessionUnread(s),
    liveWorking: optimisticWorking,
  });
  return (
    <li>
      <Link
        href={`/chat?session=${encodeURIComponent(s.id)}`}
        onMouseEnter={() => onPrefetch(s.id)}
        onFocus={() => onPrefetch(s.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenMenu(s.id, e.clientX, e.clientY);
        }}
        {...longPress(s.id)}
        className={cn(
          'group block w-full rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors select-none [-webkit-touch-callout:none]',
          active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
          s.closedAt && 'opacity-60',
          s.hiddenAt && 'opacity-50',
          s.hibernatedAt && !s.closedAt && 'opacity-60',
        )}
        title={s.title || s.preview || s.agentName}
      >
        <div className="flex items-start gap-2 min-w-0">
          <span
            className={cn('mt-1.5 h-1.5 w-1.5 rounded-full shrink-0', status.dot, status.pulse && 'animate-pulse')}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-1.5">
              <span className={cn('flex-1 truncate text-[13px]', active ? 'text-sidebar-foreground font-medium' : 'text-sidebar-foreground/85')}>
                {s.title || s.preview || s.agentName}
              </span>
              {pinned && (
                <Pin className="h-3 w-3 shrink-0 self-center -rotate-45 fill-current text-muted-foreground/70" aria-label="pinned" />
              )}
              {s.hiddenAt && (
                <EyeOff className="h-3 w-3 shrink-0 self-center text-muted-foreground/60" aria-label="hidden" />
              )}
              {s.hibernatedAt && (
                <Moon className="h-3 w-3 shrink-0 self-center text-muted-foreground/60" aria-label="hibernated — wakes on send" />
              )}
              <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                {relTime(s.lastMessageAt ?? s.startedAt)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/75 tabular-nums truncate">
              <span className="truncate">{s.agentName}</span>
              {status.key !== 'ready' && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span>{status.label}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
});

// The /chat session list — per-agent sessions with live-working dots, unread
// state, pins, a context menu, hide/hibernate/restart actions, and long-press on
// touch. Rendered by AppSidebar; the heaviest of the three worker Recent* lists.
export function RecentSessions() {
  const search = useSearchParams();
  const activeId = search.get('session');
  const sessions = trpc.chat.listSessions.useQuery({}, { refetchInterval: 5_000 });
  // The orchestrator (义脑) lives in /brain — keep its conversations out of the
  // worker session recents. agents.list is cached (shared), so this is cheap.
  const orchestratorsQ = trpc.agents.list.useQuery(undefined, { staleTime: 60_000 });
  const orchestratorName = (orchestratorsQ.data ?? []).find((a) => a.isOrchestrator)?.name;
  const utils = trpc.useUtils();
  const confirm = useConfirm();
  const liveWorkingSince = useLiveWorking();
  const pins = usePins();
  // Custom right-click menu: viewport coords + the session it targets, or null.
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // Touch long-press opens the SAME menu — phones have no right-click.
  const openMenuAt = useCallback((id: string, x: number, y: number) => setMenu({ x, y, id }), []);
  const longPress = useLongPress(openMenuAt);

  // Hidden sessions are dropped from the list; a footer toggle reveals them.
  const [showHidden, setShowHidden] = useState(false);
  // Hide/unhide optimistically so the row vanishes (or reappears) on the click,
  // not on the next 5s poll — then reconcile on settle.
  const setHidden = trpc.chat.setHidden.useMutation({
    onMutate: async ({ id, hidden }) => {
      await utils.chat.listSessions.cancel({});
      const prev = utils.chat.listSessions.getData({});
      utils.chat.listSessions.setData({}, (old) =>
        old?.map((s) => (s.id === id ? { ...s, hiddenAt: hidden ? new Date() : null } : s)),
      );
      return { prev };
    },
    onError: (_e, _v, context) => {
      if (context?.prev) utils.chat.listSessions.setData({}, context.prev);
    },
    onSettled: () => { void utils.chat.listSessions.invalidate(); },
  });

  // The three big chat actions (compact / restart / delete) also live in an open
  // chat's header; surfaced here on the right-click menu so you can run them on
  // ANY session without opening it. Compact just injects `/compact` (benign →
  // straight through); restart + delete are disruptive so they confirm first,
  // matching the header's two-step and the cron / skill delete confirms.
  const compactSession = trpc.chat.send.useMutation({
    onSuccess: (_d, vars) => {
      void utils.chat.listMessages.invalidate({ sessionId: vars.sessionId });
      void utils.chat.listSessions.invalidate();
    },
  });
  const restartSession = trpc.chat.requestSessionRestart.useMutation({
    onSuccess: () => { void utils.chat.listSessions.invalidate(); },
  });
  const hibernateSession = trpc.chat.requestHibernate.useMutation({
    onSuccess: () => { void utils.chat.listSessions.invalidate(); },
  });
  const deleteSession = trpc.chat.deleteSession.useMutation({
    onSuccess: (_d, vars) => {
      // Deleting the session you're viewing: hard-nav to /chat (the Next 16
      // custom-server router strands you on the dead URL — see the chat page's
      // delete note). A background session: just refresh so its row vanishes.
      if (vars.id === activeId) { window.location.href = '/chat'; return; }
      void utils.chat.listSessions.invalidate();
    },
  });

  // Local agent filter — persisted in sessionStorage so it survives reloads
  // but doesn't pollute the URL. "" means "all agents".
  const [filter, setFilter] = useState<string>('');
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? sessionStorage.getItem('hermit:chat-filter') : null;
    if (stored) setFilter(stored);
  }, []);
  const onFilterChange = (v: string) => {
    setFilter(v);
    try {
      if (v) sessionStorage.setItem('hermit:chat-filter', v);
      else sessionStorage.removeItem('hermit:chat-filter');
    } catch { /* private mode etc. — fine */ }
  };

  // Ephemeral text search over recents — matches the displayed title (or preview
  // fallback) + agent name. Not persisted: a quick find, not a scoping choice.
  const [q, setQ] = useState('');

  // Prefetch a session's message window on hover/focus (intent to open) so the
  // click lands as a cache hit. This REPLACED an eager prefetch of the top-8
  // sessions on every dashboard open, which fired 8 full 60-message fetches —
  // for heavy sessions ~hundreds of KB (measured: 4 fetches ≈ 561KB) that
  // competed with the CURRENT session's own load and inflated server TTFB to
  // ~1s. react-query's staleTime dedupes repeat hovers; limit MUST equal
  // chat/page.tsx INITIAL_WINDOW so the open query key matches (no skeleton flash).
  const prefetchSession = useCallback(
    (id: string) => {
      void utils.chat.listMessages.prefetch({ sessionId: id, limit: 60 }, { staleTime: 60_000 });
    },
    [utils],
  );

  const agentNames = useMemo(() => {
    const names = new Set<string>();
    sessions.data?.forEach((s) => { if (s.agentName !== orchestratorName && s.origin !== 'dispatch') names.add(s.agentName); });
    return Array.from(names).sort();
  }, [sessions.data, orchestratorName]);
  // Worker sessions (orchestrator/Brain lives only in /brain). Brain's dispatch
  // sessions (origin:'dispatch') are the brain's, shown only in /brain/dispatch —
  // keep them out of the worker chat recents.
  const baseRows = useMemo(
    () => (sessions.data ?? []).filter((s) => s.agentName !== orchestratorName && s.origin !== 'dispatch'),
    [sessions.data, orchestratorName],
  );
  const hiddenCount = useMemo(() => baseRows.filter((s) => s.hiddenAt).length, [baseRows]);
  const visible = useMemo(() => {
    // Hidden sessions drop out of the list unless the footer toggle is on.
    let rows = showHidden ? baseRows : baseRows.filter((s) => !s.hiddenAt);
    if (filter) rows = rows.filter((s) => s.agentName === filter);
    const needle = q.trim().toLowerCase();
    if (needle) {
      rows = rows.filter(
        (s) =>
          (s.title || s.preview || '').toLowerCase().includes(needle) ||
          s.agentName.toLowerCase().includes(needle),
      );
    }
    // Pinned sessions float to the top — a stable sort keeps the lastMessageAt
    // order within the pinned and unpinned groups.
    if (pins.size) rows = [...rows].sort((a, b) => (pins.has(b.id) ? 1 : 0) - (pins.has(a.id) ? 1 : 0));
    return rows;
  }, [baseRows, showHidden, filter, q, pins]);

  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>Recents</span>
        <span className="tabular-nums text-muted-foreground/50">{visible.length}</span>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: pins.has(menu.id) ? 'Unpin' : 'Pin',
              icon: <Pin className="h-3.5 w-3.5 -rotate-45 fill-current" />,
              onClick: () => togglePin(menu.id),
            },
            (() => {
              const isHidden = !!(sessions.data ?? []).find((s) => s.id === menu.id)?.hiddenAt;
              return {
                label: isHidden ? 'Unhide' : 'Hide',
                icon: isHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />,
                onClick: () => setHidden.mutate({ id: menu.id, hidden: !isHidden }),
              };
            })(),
            {
              label: 'Compact',
              icon: <FoldVertical className="h-3.5 w-3.5" />,
              onClick: async () => {
                const id = menu.id;
                if (await confirm({
                  title: 'Compact session',
                  message: "Run /compact to summarize the conversation and shrink the agent's context window? Continuity is kept.",
                  confirmLabel: 'Compact',
                }))
                  compactSession.mutate({ sessionId: id, text: '/compact', images: [], files: [] });
              },
            },
            {
              label: 'Restart',
              icon: <RotateCw className="h-3.5 w-3.5" />,
              onClick: async () => {
                const id = menu.id;
                if (await confirm({
                  title: 'Restart session',
                  message: "Kill this session's tmux pane? Your next message respawns claude with history preserved (--resume).",
                  confirmLabel: 'Restart',
                }))
                  restartSession.mutate({ id });
              },
            },
            ...(() => {
              // Hibernate only makes sense for a live session (a pane to free);
              // a sleeping one wakes on send, no menu action needed.
              const s = (sessions.data ?? []).find((x) => x.id === menu.id);
              if (!s?.alive || s.hibernatedAt) return [];
              return [{
                label: 'Hibernate',
                icon: <Moon className="h-3.5 w-3.5" />,
                onClick: async () => {
                  const id = menu.id;
                  if (await confirm({
                    title: 'Hibernate session',
                    message: "Kill this session's pane to free its memory? It sleeps until your next message, which wakes it with full history (--resume).",
                    confirmLabel: 'Hibernate',
                  }))
                    hibernateSession.mutate({ id });
                },
              }];
            })(),
            {
              label: 'Delete',
              icon: <Trash2 className="h-3.5 w-3.5" />,
              danger: true,
              onClick: async () => {
                const id = menu.id;
                if (await confirm({
                  title: 'Delete session',
                  message: 'Delete this session and all its messages? This cannot be undone.',
                  confirmLabel: 'Delete',
                  danger: true,
                }))
                  deleteSession.mutate({ id });
              },
            },
          ]}
        />
      )}
      {(sessions.data?.length ?? 0) > 0 && (
        <div className="px-2 pb-1 flex items-center gap-1.5">
          {/* Left: a simple title/agent text search over the recents list. */}
          <div className="relative flex-1 min-w-0">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" aria-hidden="true" />
            <input
              data-sidebar-search
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }}
              placeholder="搜索标题 / agent"
              aria-label="search recents by title or agent"
              className={cn(
                'h-8 w-full rounded-lg border border-sidebar-border bg-sidebar/60 pl-7 text-[12px] text-sidebar-foreground/90 placeholder:text-muted-foreground/50 outline-none transition-colors hover:border-sidebar-foreground/20 focus-visible:border-sidebar-foreground/40 focus-visible:ring-1 focus-visible:ring-sidebar-foreground/15',
                q ? 'pr-7' : 'pr-2',
              )}
            />
            {q && (
              <button
                type="button"
                tabIndex={-1}
                aria-label="clear"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setQ('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {/* Right: the existing per-agent filter (only when >1 agent). Custom
              base-ui Select; modal={false} so its backdrop can't lock the page —
              the default scroll-lock left sidebar links unclickable after a cycle. */}
          {agentNames.length > 1 && (
            <Select value={filter} onValueChange={(v) => onFilterChange(v ?? '')} modal={false}>
              <SelectTrigger
                aria-label="filter sessions by agent"
                className="w-auto shrink-0 border-sidebar-border bg-sidebar/60 font-mono text-sidebar-foreground/90 hover:border-sidebar-foreground/20 hover:bg-sidebar-accent/60 focus-visible:border-sidebar-foreground/40 focus-visible:ring-sidebar-foreground/15"
              >
                <SelectValue>{(v: string | null) => (v ? v : 'All agents')}</SelectValue>
              </SelectTrigger>
              <SelectContent className="font-mono">
                <SelectItem value="">
                  All agents <span className="text-muted-foreground">· {sessions.data?.length ?? 0}</span>
                </SelectItem>
                {agentNames.map((n) => {
                  const count = (sessions.data ?? []).filter((s) => s.agentName === n).length;
                  return (
                    <SelectItem key={n} value={n}>
                      {n} <span className="text-muted-foreground">· {count}</span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {sessions.isPending ? (
          <div className="space-y-1 px-1 pt-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-8 rounded-md bg-sidebar-accent/40 animate-pulse" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {q.trim() ? `没有匹配 “${q.trim()}” 的会话。` : filter ? `no sessions for ${filter}.` : 'no chats yet — start a New chat.'}
          </p>
        ) : (
          <ul className="space-y-px">
            {visible.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={activeId === s.id}
                liveAt={liveWorkingSince(s.id)}
                pinned={pins.has(s.id)}
                onPrefetch={prefetchSession}
                onOpenMenu={openMenuAt}
                longPress={longPress}
              />
            ))}
          </ul>
        )}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowHidden((v) => !v)}
          className="mx-2 mb-2 mt-1 flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/80 cursor-pointer"
        >
          {showHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          <span>{showHidden ? 'Hide hidden chats' : `Show hidden (${hiddenCount})`}</span>
        </button>
      )}
    </div>
  );
}
