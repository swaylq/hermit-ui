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

import { useState, useCallback, useMemo, useEffect, memo, lazy, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Trash2, RotateCw, FoldVertical, X, Search, Pin, Eye, EyeOff, Moon, ChevronRight, FolderPlus, FolderOpen, Pencil, ListTree, Archive, ArchiveRestore } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { sessionRecencyAt } from '@/lib/session-recency';
import { sessionStatusView } from '@/lib/session-status';
import { isSessionUnread } from '@/lib/session-read';
import { useLiveWorking, useLiveStatus, type LiveStatus } from '@/lib/session-live';
import { usePins, togglePin } from '@/lib/session-pins';
import { useSessionView, setSessionView, useAgentDrawers, setAgentDrawer, type SessionView } from '@/lib/session-view';
import { useLongPress } from '@/lib/use-long-press';
import { readChatFilter, writeChatFilter } from '@/lib/chat-filter';
import { readCachedSessions, writeCachedSessions } from '@/lib/session-list-cache';
import { ContextMenu } from '@/components/ui/context-menu';
import { useConfirm, usePrompt } from '@/components/ui/confirm-dialog';
import { SidebarFindInput } from '@/components/sidebar/sidebar-find-input';
import { TrashedAgents } from '@/components/sidebar/trashed-agents';
import { cronStatusTone, type CronStatusTone } from '@/lib/cron-status';

// The agent filter dropdown, split off so base-ui's Select (and the floating-ui
// positioning engine it carries) stays OUT of the app-shell chunk every route
// loads before first paint — this file is reachable from the root layout via
// AppSidebar. It's the only base-ui Select in that graph; behind lazy() it
// becomes its own chunk, fetched when the chat recents list actually mounts.
const AgentFilterSelect = lazy(() => import('@/components/sidebar/agent-filter-select'));

type RouterOutputs = inferRouterOutputs<AppRouter>;
type CronListItem = RouterOutputs['cron']['list'][number];
type AgentListItem = RouterOutputs['agents']['list'][number];
type SessionListItem = RouterOutputs['chat']['listSessions'][number];

function fmtEvery(sec: number): string {
  if (sec % 3600 === 0) return `every ${sec / 3600}h`;
  if (sec % 60 === 0) return `every ${sec / 60}m`;
  return `every ${sec}s`;
}

// Mirrors the server's own limit (sessionGroups router, `Name`) so the field stops
// where zod would have rejected.
const GROUP_NAME_MAX = 40;

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
                  title={`${c.unreadCount} unread run${c.unreadCount === 1 ? '' : 's'}`}
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
        <SidebarFindInput value={q} onChange={setQ} placeholder="Search crons" label="search crons by title or agent" />
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
          <p className="px-2 py-2 text-xs text-muted-foreground">No crons match “{q.trim()}”.</p>
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
        <SidebarFindInput value={q} onChange={setQ} placeholder="Search agents" label="search agents by name" />
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
          <p className="px-2 py-2 text-xs text-muted-foreground">No agents match “{q.trim()}”.</p>
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
// sharing), `active`/`liveAt`/`live`/`pinned` are primitives, and onPrefetch/
// onOpenMenu/longPress are stable, so an unchanged row bails. The optimistic-working
// / unread / status derivation runs INSIDE the row (only when it re-renders), and the
// per-row handlers are built here from the stable callbacks — neither defeats the memo.
const SessionRow = memo(function SessionRow({
  session: s,
  active,
  liveAt,
  live,
  pinned,
  onPrefetch,
  onOpenMenu,
  longPress,
}: {
  session: SessionListItem;
  active: boolean;
  liveAt: number | null;
  live: LiveStatus | null;
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
  // …but a chat page open on this session doesn't have to guess: it reads the
  // message stream and the pending-interaction blocks, so when it is speaking
  // (`live` non-null) its reading REPLACES the guess in both directions — it can
  // say "working" ~13s before any snapshot could, and its 'idle' retires a send
  // stamp whose turn quietly died. Same function, same row, same inputs as the
  // header two inches to the right; that is the point. See lib/session-live.
  const status = sessionStatusView(s, {
    unread: isSessionUnread(s),
    liveWorking: live !== null ? live === 'working' : optimisticWorking,
    needsYou: live === 'needs-you',
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
                <Moon className="h-3 w-3 shrink-0 self-center text-muted-foreground/60" aria-label="asleep — wakes on send" />
              )}
              <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                {relTime(sessionRecencyAt(s))}
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

// How the session list is arranged: one tree button in the section header. Lit =
// the agent tree; unlit = the list the way you filed it yourself (your groups,
// then the loose recents). One control with a state, not two competing ones —
// which is also why the header label says which arrangement you're looking at.
function ViewToggle({ view }: { view: SessionView }) {
  const on = view === 'agents';
  return (
    <button
      type="button"
      onClick={() => setSessionView(on ? 'recents' : 'agents')}
      aria-pressed={on}
      aria-label="Group by agent"
      title={on ? 'Grouped by agent — click for your own groups' : 'Group by agent'}
      className={cn(
        // h-6 rather than h-5: the glyph is small, but this gets pressed with a
        // thumb in the installed PWA.
        'ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-md transition-colors cursor-pointer',
        on
          ? 'bg-sidebar-accent text-sidebar-foreground'
          : 'text-muted-foreground/50 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
      )}
    >
      <ListTree className="h-3.5 w-3.5" />
    </button>
  );
}

// The /chat session list — per-agent sessions with live-working dots, unread
// state, pins, a context menu, hide/hibernate/restart actions, and long-press on
// touch. Rendered by AppSidebar; the heaviest of the three worker Recent* lists.
export function RecentSessions() {
  const search = useSearchParams();
  const activeId = search.get('session');
  // `placeholderData`, not `initialData`: the list paints on the first frame from
  // the last known copy of THIS machine's sessions, while the real fetch — already
  // in flight — replaces it ~200ms later (much longer on a phone). initialData
  // would be treated as real and could suppress that refetch.
  //
  // A machine switch is a full document navigation, so React Query starts empty
  // every single time; without this the sidebar is blank for a whole round trip on
  // the one query that is 90 KB.
  const sessions = trpc.chat.listSessions.useQuery({}, {
    refetchInterval: 5_000,
    placeholderData: () => readCachedSessions<SessionListItem>(),
  });
  // Structural sharing means this only fires when the rows genuinely differ, and
  // the writer throttles beyond that.
  useEffect(() => {
    if (sessions.data && !sessions.isPlaceholderData) writeCachedSessions(sessions.data);
  }, [sessions.data, sessions.isPlaceholderData]);
  // The orchestrator (义脑) lives in /brain — keep its conversations out of the
  // worker session recents. agents.list is cached (shared), so this is cheap.
  const orchestratorsQ = trpc.agents.list.useQuery(undefined, { staleTime: 60_000 });
  const orchestratorName = (orchestratorsQ.data ?? []).find((a) => a.isOrchestrator)?.name;
  const utils = trpc.useUtils();
  const confirm = useConfirm();
  const promptFor = usePrompt();
  const liveWorkingSince = useLiveWorking();
  // What a chat page open on a session says about it, if one is (lib/session-live).
  const liveStatus = useLiveStatus();
  const pins = usePins();
  // Which arrangement, and which agent drawers the user has opened/shut in the
  // by-agent one. Both are local view state (lib/session-view).
  const view = useSessionView();
  const agentDrawers = useAgentDrawers();
  // Custom right-click menu: viewport coords + the session it targets, or null.
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // Touch long-press opens the SAME menu — phones have no right-click.
  const openMenuAt = useCallback((id: string, x: number, y: number) => setMenu({ x, y, id }), []);
  const longPress = useLongPress(openMenuAt);
  // The same two gestures on a group HEADER open the group's own menu.
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const openGroupMenuAt = useCallback((id: string, x: number, y: number) => setGroupMenu({ x, y, id }), []);
  const groupLongPress = useLongPress(openGroupMenuAt);

  // Hidden sessions are dropped from the list; a footer toggle reveals them.
  const [showHidden, setShowHidden] = useState(false);
  // What the footer toggle reveals. Hidden and archived mean the same thing to this
  // list — "not part of what I'm working on" — so they hide together and come back
  // together. Archiving used to leave the session in place wearing a `closed` badge,
  // which meant the tidying action didn't actually tidy the list.
  //
  // A PINNED session is never put away, whatever its flags say. Pins live in
  // localStorage (session-pins.ts), so `computeCleanup` cannot see them and cannot
  // spare a pinned chat the way it spares a grouped or human-named one — a pin is
  // the strongest "keep this in front of me" signal in the product and the only one
  // the server is blind to. Honouring it here is what stops an archive sweep from
  // silently removing something the human explicitly pinned. (Archiving it is still
  // fine: it stays visible, wearing its `closed` badge, one click from reopening.)
  const isPutAway = useCallback(
    (s: SessionListItem) => !pins.has(s.id) && (Boolean(s.hiddenAt) || Boolean(s.closedAt)),
    [pins],
  );
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
  const archiveSession = trpc.chat.archiveSession.useMutation({
    onSuccess: () => { void utils.chat.listSessions.invalidate(); },
  });
  // Bring an archived chat back into the sidebar. Only clears closedAt — the
  // session stays hibernated and wakes on the next message (--resume), which is
  // the same thing that would have happened had it never been archived.
  const reopenSession = trpc.chat.reopenSession.useMutation({
    onSuccess: () => { void utils.chat.listSessions.invalidate(); },
  });
  // Routes through the recycle bin, not `deleteSession`: trashing hibernates the
  // pane first (so the ~500MB claude can't be stranded by the row disappearing —
  // see docs/session-cleanup-design.md) and stays recoverable for the machine's
  // retention window. The menu item still reads "Delete" because that is what the
  // user means; the confirm text is where the bin is explained.
  const deleteSession = trpc.chat.trashSessions.useMutation({
    onSuccess: (_d, vars) => {
      // Deleting the session you're viewing: hard-nav to /chat (the Next 16
      // custom-server router strands you on the dead URL — see the chat page's
      // delete note). A background session: just refresh so its row vanishes.
      if (vars.ids.includes(activeId ?? '')) { window.location.href = '/chat'; return; }
      void utils.chat.listSessions.invalidate();
    },
  });

  // Local agent filter — persisted in sessionStorage so it survives reloads
  // but doesn't pollute the URL. "" means "all agents".
  //
  // Scoped PER MACHINE, for the same reason lib/last-session.ts scopes its memory:
  // the stored value is an agent NAME, and agents are machine-scoped. A single
  // shared key survived a workspace switch and kept filtering by an agent the new
  // machine has never heard of, so the recents list came back EMPTY — the reported
  // "switching machines sometimes shows no sessions". Reproduced at 33 rows → 1,
  // with the dropdown still displaying the other machine's agent.
  // Read in a lazy initializer, not an effect: an effect would render the
  // unfiltered list first and re-render filtered, and it is what tripped the
  // setState-in-an-effect rule here.
  const [stored, setStored] = useState<string>(() => readChatFilter());
  const onFilterChange = (v: string) => {
    setStored(v);
    writeChatFilter(v);
  };
  // What actually applies. Second line of defence for what machine-scoping can't
  // cover — the filtered agent was deleted, or the value predates the scoping — and
  // DERIVED rather than corrected via setState, which matters beyond lint: the
  // stored choice survives untouched, so a filter that means nothing here starts
  // working again the moment you switch back to the machine it belongs to.
  //
  // While `sessions.data` is undefined every name looks unknown, so hold the stored
  // value until the list settles; there are no rows to filter yet anyway.
  const filter = useMemo(() => {
    if (!stored || !sessions.data) return stored;
    return sessions.data.some((s) => s.agentName === stored) ? stored : '';
  }, [stored, sessions.data]);

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
  // Per-agent session count for the filter dropdown's option labels. A callback
  // rather than a prebuilt map so it stays referentially stable across the 5s
  // poll's structurally-shared no-op responses.
  const agentSessionCount = useCallback(
    (name: string) => (sessions.data ?? []).reduce((n, s) => (s.agentName === name ? n + 1 : n), 0),
    [sessions.data],
  );
  // Worker sessions (orchestrator/Brain lives only in /brain). Brain's dispatch
  // sessions (origin:'dispatch') are the brain's, shown only in /brain/dispatch —
  // keep them out of the worker chat recents.
  const baseRows = useMemo(
    () => (sessions.data ?? []).filter((s) => s.agentName !== orchestratorName && s.origin !== 'dispatch'),
    [sessions.data, orchestratorName],
  );
  const putAwayCount = useMemo(() => baseRows.filter((s) => isPutAway(s)).length, [baseRows, isPutAway]);

  // ── Groups ────────────────────────────────────────────────────────────────
  // Drawers above the recents. A grouped session LEAVES the flat list — that's the
  // whole mechanism: the list stays recency-ordered and short, and the noise (70 open
  // sessions, cron mailboxes bumping themselves to the top on every report) folds away
  // without being hidden.
  const groupsQ = trpc.sessionGroups.list.useQuery(undefined, { staleTime: 30_000 });
  const groups = groupsQ.data ?? [];
  const setCollapsed = trpc.sessionGroups.setCollapsed.useMutation({
    onMutate: async ({ id, collapsed }) => {
      // Optimistic: a drawer must open on the click, not on the round-trip.
      utils.sessionGroups.list.setData(undefined, (old) =>
        old?.map((g) => (g.id === id ? { ...g, collapsed } : g)),
      );
    },
    onSettled: () => utils.sessionGroups.list.invalidate(),
  });
  const assignGroup = trpc.sessionGroups.assign.useMutation({
    onSuccess: () => { utils.chat.listSessions.invalidate(); utils.sessionGroups.list.invalidate(); },
  });
  const createGroup = trpc.sessionGroups.create.useMutation({
    onSuccess: () => utils.sessionGroups.list.invalidate(),
  });
  const renameGroup = trpc.sessionGroups.rename.useMutation({
    // Optimistic for the same reason as setCollapsed: the new name is already on
    // screen in the dialog, so the header shouldn't lag a round-trip behind it.
    onMutate: async ({ id, name }) => {
      utils.sessionGroups.list.setData(undefined, (old) =>
        old?.map((g) => (g.id === id ? { ...g, name } : g)),
      );
    },
    onSettled: () => utils.sessionGroups.list.invalidate(),
  });
  const removeGroup = trpc.sessionGroups.remove.useMutation({
    // Both lists move: the drawer goes, and its sessions (groupId now null, the FK
    // is ON DELETE SET NULL) reappear in the flat recents.
    onSuccess: () => { utils.sessionGroups.list.invalidate(); utils.chat.listSessions.invalidate(); },
  });
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // Hidden and archived chats drop out of the list — but NOT out of search. They
    // are put away, not gone, and most of a machine's history is now archived
    // (88 of 124 here), so a "Search chats" that silently can't see it is worse
    // than no search at all. Same rule the grouped filter below already follows,
    // for the same reason: while you are searching you want it found wherever it
    // is. They stay visually distinct — an archived row renders its `closed` badge.
    let rows = showHidden || needle ? baseRows : baseRows.filter((s) => !isPutAway(s));
    if (filter) rows = rows.filter((s) => s.agentName === filter);
    if (needle) {
      rows = rows.filter(
        (s) =>
          (s.title || s.preview || '').toLowerCase().includes(needle) ||
          s.agentName.toLowerCase().includes(needle),
      );
    }
    // A grouped session lives in its drawer, not here — UNLESS you're searching, in
    // which case you want to find it wherever it is.
    if (!needle) rows = rows.filter((s) => !s.groupId);
    // Pinned sessions float to the top — a stable sort keeps the lastMessageAt
    // order within the pinned and unpinned groups.
    if (pins.size) rows = [...rows].sort((a, b) => (pins.has(b.id) ? 1 : 0) - (pins.has(a.id) ? 1 : 0));
    return rows;
  }, [baseRows, showHidden, isPutAway, filter, q, pins]);

  // Sessions per drawer, in the same recency order the flat list uses.
  const grouped = useMemo(() => {
    const rows = showHidden ? baseRows : baseRows.filter((s) => !isPutAway(s));
    const by = new Map<string, typeof rows>();
    for (const s of rows) {
      if (!s.groupId) continue;
      const arr = by.get(s.groupId);
      if (arr) arr.push(s);
      else by.set(s.groupId, [s]);
    }
    return by;
  }, [baseRows, showHidden, isPutAway]);

  // ── By-agent view ─────────────────────────────────────────────────────────
  // A different lens on the same sessions, not a second filing system: the manual
  // groups are ignored here, so a session filed into a drawer still appears under
  // its agent. Nothing is written — switching back leaves the groups as they were.
  const agentSections = useMemo(() => {
    if (view !== 'agents') return [];
    let rows = showHidden ? baseRows : baseRows.filter((s) => !isPutAway(s));
    if (filter) rows = rows.filter((s) => s.agentName === filter);
    const by = new Map<string, SessionListItem[]>();
    for (const s of rows) {
      const arr = by.get(s.agentName);
      if (arr) arr.push(s);
      else by.set(s.agentName, [s]);
    }
    // baseRows is recency-ordered, so an agent's first appearance orders the
    // sections: whoever you talked to last is on top. Pins float within a section.
    return Array.from(by, ([name, list]) => ({
      name,
      rows: pins.size
        ? [...list].sort((a, b) => (pins.has(b.id) ? 1 : 0) - (pins.has(a.id) ? 1 : 0))
        : list,
    }));
  }, [view, baseRows, showHidden, isPutAway, filter, pins]);

  // The agent whose session is open — its drawer starts open so switching views
  // doesn't lose sight of where you are.
  const activeAgentName = useMemo(
    () => (sessions.data ?? []).find((s) => s.id === activeId)?.agentName,
    [sessions.data, activeId],
  );

  // A search returns one flat list of hits in EITHER view — making you open
  // drawers to find a hit would be worse than no grouping at all.
  const searching = q.trim().length > 0;
  const byAgent = view === 'agents' && !searching;
  const shownCount = byAgent ? agentSections.reduce((n, s) => n + s.rows.length, 0) : visible.length;
  const nothingToShow = byAgent
    ? agentSections.length === 0
    : visible.length === 0 && (searching || grouped.size === 0);

  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>{view === 'agents' ? 'By agent' : 'Recents'}</span>
        <span className="tabular-nums text-muted-foreground/50">{shownCount}</span>
        {(sessions.data?.length ?? 0) > 0 && <ViewToggle view={view} />}
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
            // Filing lives next to Pin/Hide because it's the same kind of act: deciding
            // where something sits, not doing anything to the conversation itself.
            ...groups
              .filter((g) => g.id !== (sessions.data ?? []).find((x) => x.id === menu.id)?.groupId)
              .map((g) => ({
                label: `Move to ${g.name}`,
                icon: <FolderOpen className="h-3.5 w-3.5" />,
                onClick: () => assignGroup.mutate({ sessionId: menu.id, groupId: g.id }),
              })),
            ...((sessions.data ?? []).find((x) => x.id === menu.id)?.groupId
              ? [{
                  label: 'Remove from group',
                  icon: <FolderOpen className="h-3.5 w-3.5" />,
                  onClick: () => assignGroup.mutate({ sessionId: menu.id, groupId: null }),
                }]
              : []),
            {
              label: 'New group…',
              icon: <FolderPlus className="h-3.5 w-3.5" />,
              onClick: async () => {
                const id = menu.id;
                // The app's own dialog, not window.prompt — same portal, dim and
                // Esc/Enter handling as every confirm in here (and it survives an
                // installed PWA, where the native prompt is a system sheet).
                const name = await promptFor({
                  title: 'New group',
                  placeholder: 'Group name',
                  confirmLabel: 'Create',
                  maxLength: GROUP_NAME_MAX,
                });
                if (!name) return;
                const g = await createGroup.mutateAsync({ name });
                await assignGroup.mutateAsync({ sessionId: id, groupId: g.id });
              },
            },
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
              // Archived chats are only reachable through `Show hidden & archived`,
              // so this is the one place the way back can live. First in the group
              // because for an archived session it is the ONLY thing you want.
              const s = (sessions.data ?? []).find((x) => x.id === menu.id);
              if (!s?.closedAt) return [];
              return [{
                label: 'Restore from archive',
                icon: <ArchiveRestore className="h-3.5 w-3.5" />,
                onClick: () => reopenSession.mutate({ id: menu.id }),
              }];
            })(),
            ...(() => {
              // Was "Hibernate", which freed the process but left the chat sitting in
              // the sidebar looking live — the exact half-state this feature exists to
              // remove, and the last way left to produce it by hand. Archiving does
              // both. Offered for anything not already archived, asleep or not: the
              // point is getting it out of the list, which applies either way.
              const s = (sessions.data ?? []).find((x) => x.id === menu.id);
              if (!s || s.closedAt) return [];
              return [{
                label: 'Archive',
                icon: <Archive className="h-3.5 w-3.5" />,
                onClick: async () => {
                  const id = menu.id;
                  if (await confirm({
                    title: 'Archive session',
                    message: "Take this chat out of the sidebar and free its memory? It sleeps until your next message, which wakes it with full history (--resume). Right-click it under `Show hidden & archived` to restore.",
                    confirmLabel: 'Archive',
                  }))
                    archiveSession.mutate({ id });
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
                  message: 'Moves it to the recycle bin (Settings → System), where it can be restored until it is purged.',
                  confirmLabel: 'Delete',
                  danger: true,
                }))
                  deleteSession.mutate({ ids: [id], reason: 'manual' });
              },
            },
          ]}
        />
      )}
      {/* A group's own menu — right-click (or long-press) its header. Renaming a
          drawer isn't something you do while working, so it stays off the header
          rather than parking an edit button on every one of them. */}
      {groupMenu && (
        <ContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          onClose={() => setGroupMenu(null)}
          items={[
            {
              label: 'Rename…',
              icon: <Pencil className="h-3.5 w-3.5" />,
              onClick: async () => {
                const g = groups.find((x) => x.id === groupMenu.id);
                if (!g) return;
                const name = await promptFor({
                  title: 'Rename group',
                  defaultValue: g.name,
                  placeholder: 'Group name',
                  confirmLabel: 'Rename',
                  maxLength: GROUP_NAME_MAX,
                });
                if (!name || name === g.name) return;
                renameGroup.mutate({ id: g.id, name });
              },
            },
            {
              label: 'Delete group',
              icon: <Trash2 className="h-3.5 w-3.5" />,
              danger: true,
              onClick: async () => {
                const g = groups.find((x) => x.id === groupMenu.id);
                if (!g) return;
                const n = g.sessionCount;
                if (await confirm({
                  title: 'Delete group',
                  // Say what survives: this empties a drawer, it does not delete
                  // conversations (the router never touches them).
                  message: n === 0
                    ? `Delete “${g.name}”? It’s empty.`
                    : n === 1
                      ? `Delete “${g.name}”? The conversation in it is kept — it goes back to the recents list.`
                      : `Delete “${g.name}”? The ${n} conversations in it are kept — they go back to the recents list.`,
                  confirmLabel: 'Delete',
                  danger: true,
                }))
                  removeGroup.mutate({ id: g.id });
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
              placeholder="Search chats"
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
          {/* Right: the existing per-agent filter (only when >1 agent), lazy so
              base-ui's Select isn't in the shell chunk. Until its chunk lands the
              fallback holds the trigger's exact box, so the row doesn't reflow. */}
          {agentNames.length > 1 && (
            <Suspense
              fallback={
                <div
                  aria-hidden="true"
                  className="h-8 w-[86px] shrink-0 rounded-lg border border-sidebar-border bg-sidebar/60"
                />
              }
            >
              <AgentFilterSelect
                value={filter}
                onChange={onFilterChange}
                agentNames={agentNames}
                countFor={agentSessionCount}
                total={sessions.data?.length ?? 0}
              />
            </Suspense>
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
        ) : nothingToShow ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {q.trim() ? `No chats match “${q.trim()}”.` : filter ? `no sessions for ${filter}.` : 'no chats yet — start a New chat.'}
          </p>
        ) : byAgent ? (
          <>
            {agentSections.map((sec) => {
              // Shut by default — at this many sessions the useful thing is the
              // index of agents. The one you're reading starts open, until you say
              // otherwise (lib/session-view stores only explicit clicks).
              const open = agentDrawers[sec.name] ?? sec.name === activeAgentName;
              return (
                <div key={sec.name} className="mb-0.5">
                  <button
                    type="button"
                    onClick={() => setAgentDrawer(sec.name, !open)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground cursor-pointer"
                  >
                    <ChevronRight
                      className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate font-mono">{sec.name}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/50">{sec.rows.length}</span>
                  </button>
                  {open && (
                    <ul className="space-y-px pl-2">
                      {sec.rows.map((s) => (
                        <SessionRow
                          key={s.id}
                          session={s}
                          active={activeId === s.id}
                          liveAt={liveWorkingSince(s.id)}
                          live={liveStatus(s.id)}
                          pinned={pins.has(s.id)}
                          onPrefetch={prefetchSession}
                          onOpenMenu={openMenuAt}
                          longPress={longPress}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </>
        ) : (
          <>
            {/* Drawers first, then whatever is still loose. Hidden while searching:
                a search should return one flat list of hits, not make you open
                folders to find them. */}
            {!searching &&
              groups.map((g) => {
                const rows = grouped.get(g.id) ?? [];
                return (
                  <div key={g.id} className="mb-0.5">
                    <button
                      type="button"
                      onClick={() => setCollapsed.mutate({ id: g.id, collapsed: !g.collapsed })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        openGroupMenuAt(g.id, e.clientX, e.clientY);
                      }}
                      {...groupLongPress(g.id)}
                      aria-expanded={!g.collapsed}
                      className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground cursor-pointer select-none [-webkit-touch-callout:none]"
                    >
                      <ChevronRight
                        className={cn('h-3 w-3 shrink-0 transition-transform', !g.collapsed && 'rotate-90')}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 truncate">{g.name}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/50">{rows.length}</span>
                    </button>
                    {!g.collapsed && (
                      <ul className="space-y-px pl-2">
                        {rows.length === 0 ? (
                          <li className="px-2 py-1 text-[11px] text-muted-foreground/60">empty</li>
                        ) : (
                          rows.map((s) => (
                            <SessionRow
                              key={s.id}
                              session={s}
                              active={activeId === s.id}
                              liveAt={liveWorkingSince(s.id)}
                              live={liveStatus(s.id)}
                              pinned={pins.has(s.id)}
                              onPrefetch={prefetchSession}
                              onOpenMenu={openMenuAt}
                              longPress={longPress}
                            />
                          ))
                        )}
                      </ul>
                    )}
                  </div>
                );
              })}
            <ul className="space-y-px">
              {visible.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={activeId === s.id}
                  liveAt={liveWorkingSince(s.id)}
                  live={liveStatus(s.id)}
                  pinned={pins.has(s.id)}
                  onPrefetch={prefetchSession}
                  onOpenMenu={openMenuAt}
                  longPress={longPress}
                />
              ))}
            </ul>
          </>
        )}
      </div>
      {putAwayCount > 0 && (
        <button
          type="button"
          onClick={() => setShowHidden((v) => !v)}
          className="mx-2 mb-2 mt-1 flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/80 cursor-pointer"
        >
          {showHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          <span>{showHidden ? 'Hide put-away chats' : `Show hidden & archived (${putAwayCount})`}</span>
        </button>
      )}
    </div>
  );
}
