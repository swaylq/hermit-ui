'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  SquarePen, MessageSquare, Bot, BarChart3, Clock, Boxes, PanelLeft, MenuIcon, Plus,
  Trash2, RotateCcw, ChevronDown, Check, X, Store, ArrowLeft, Package, Search, Settings, Pin, NotebookText, Send, type LucideIcon,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { sessionStatusView } from '@/lib/session-status';
import { isSessionUnread } from '@/lib/session-read';
import { useLiveWorking } from '@/lib/session-live';
import { usePins, togglePin } from '@/lib/session-pins';
import { ContextMenu } from '@/components/ui/context-menu';
import { useLongPress } from '@/lib/use-long-press';

// ── Sidebar open/collapse state, shared so a page header can drop a hamburger ──
type SidebarCtx = {
  mobileOpen: boolean;
  setMobileOpen: (b: boolean) => void;
  collapsed: boolean;
  setCollapsed: (b: boolean) => void;
};
const Ctx = createContext<SidebarCtx | null>(null);
export function useSidebar(): SidebarCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSidebar must be used inside <SidebarProvider>');
  return v;
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsedState] = useState(false);
  // restore desktop collapse preference
  useEffect(() => {
    setCollapsedState(localStorage.getItem('hermit:sidebar-collapsed') === '1');
  }, []);
  const setCollapsed = useCallback((b: boolean) => {
    setCollapsedState(b);
    try { localStorage.setItem('hermit:sidebar-collapsed', b ? '1' : '0'); } catch {}
  }, []);
  const value = useMemo(() => ({ mobileOpen, setMobileOpen, collapsed, setCollapsed }), [mobileOpen, collapsed, setCollapsed]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Hamburger for mobile — pages render this at the top-left of their header.
export function SidebarMobileToggle({ className }: { className?: string }) {
  const { setMobileOpen } = useSidebar();
  return (
    <button
      type="button"
      onClick={() => setMobileOpen(true)}
      aria-label="open navigation"
      className={cn('lg:hidden -ml-1 p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer', className)}
    >
      <MenuIcon className="h-5 w-5" />
    </button>
  );
}

const NAV: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/cron', label: 'Cron', icon: Clock },
  // Skills + Usage live under one "Settings" entry → /skills (Skills tab); the
  // SettingsTabs strip on those pages switches between the two.
  { href: '/skills', label: 'Settings', icon: Settings },
];

// Market mode replaces the dashboard nav when the route is under /market.
const MARKET_NAV: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: '/market/skills', label: 'Skills', icon: Boxes },
  { href: '/market/templates', label: 'Templates', icon: Package },
];

// Brain mode's own menu: Chat / Memory / Dispatches.
const BRAIN_NAV: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: '/brain', label: 'Chat', icon: MessageSquare },
  { href: '/brain/memory', label: 'Memory', icon: NotebookText },
  { href: '/brain/dispatch', label: 'Dispatches', icon: Send },
];

// The hermit-crab button in the sidebar header → the dedicated 义脑 / Brain panel
// (/brain). The orchestrator lives there, kept out of the worker agent lists. The
// icon is the monochrome woodcut crab (CSS mask, bg-current) so it tints like the
// sibling header icons (muted → foreground on hover) and follows the theme.
function BrainButton({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const active = pathname.startsWith('/brain');
  return (
    <Link
      href="/brain"
      title="Brain"
      aria-label="Brain"
      className={cn(
        'inline-flex items-center justify-center p-1.5 rounded-md transition-colors cursor-pointer shrink-0',
        active
          ? 'bg-sidebar-accent text-sidebar-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
        collapsed && 'lg:hidden',
      )}
    >
      <span aria-hidden="true" className="logo-crab-mono h-5 w-5 bg-current" />
    </Link>
  );
}

// ── Brain mode: the orchestrator's own chat system in the sidebar ─────────────
// On /brain the sidebar swaps to this (mirrors the market-mode swap): a "New 义脑
// chat" button + the brain's own conversations, kept separate from the worker
// session recents. The brain's chats open inside /brain (?session=), not /chat.
function BrainSidebar({ collapsed }: { collapsed: boolean }) {
  const agents = trpc.agents.list.useQuery(undefined, { staleTime: 60_000 });
  const brain = (agents.data ?? []).find((a) => a.isOrchestrator);
  const create = trpc.chat.createSession.useMutation();
  const [busy, setBusy] = useState(false);
  const newChat = async () => {
    if (!brain || busy) return;
    setBusy(true);
    try {
      const s = await create.mutateAsync({ agentName: brain.name });
      window.location.href = `/brain?session=${encodeURIComponent(s.id)}`;
    } catch {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="px-2 mt-2">
        <button
          type="button"
          onClick={newChat}
          disabled={!brain || busy}
          title="New Brain chat"
          className={cn(
            'flex w-full items-center gap-2 rounded-lg h-9 text-sm font-medium transition-colors cursor-pointer',
            'border border-sidebar-border bg-sidebar hover:bg-sidebar-accent text-sidebar-foreground disabled:opacity-50',
            collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3',
          )}
        >
          <SquarePen className="h-4 w-4 shrink-0" />
          <span className={cn('truncate', collapsed && 'lg:hidden')}>{busy ? '…' : 'New Brain chat'}</span>
        </button>
      </div>
      {!collapsed && <RecentBrainSessions brainName={brain?.name} />}
    </>
  );
}

// The brain's own conversations — only the orchestrator's sessions, linking into
// /brain (not /chat). The worker recents filter these out, so this is their home.
function RecentBrainSessions({ brainName }: { brainName?: string }) {
  const search = useSearchParams();
  const activeId = search.get('session');
  const sessions = trpc.chat.listSessions.useQuery(
    { agentName: brainName },
    { enabled: !!brainName, refetchInterval: 5_000 },
  );
  const rows = [...(sessions.data ?? [])].sort(
    (a, b) => new Date(b.lastMessageAt ?? b.startedAt).getTime() - new Date(a.lastMessageAt ?? a.startedAt).getTime(),
  );
  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>Brain chats</span>
        <span className="tabular-nums text-muted-foreground/50">{rows.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {!brainName ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No Brain yet — set one up in the main area.</p>
        ) : sessions.isPending ? (
          <div className="space-y-1 px-1 pt-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 rounded-md bg-sidebar-accent/40 animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No conversations yet — use New Brain chat above.</p>
        ) : (
          <ul className="space-y-px">
            {rows.map((s) => {
              const active = activeId === s.id;
              return (
                <li key={s.id}>
                  <Link
                    href={`/brain?session=${encodeURIComponent(s.id)}`}
                    className={cn(
                      'group block w-full rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors',
                      active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
                    )}
                    title={s.title || s.preview || 'Brain chat'}
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <span
                        className={cn('mt-1.5 h-1.5 w-1.5 rounded-full shrink-0', s.alive ? 'bg-emerald-500' : 'border border-muted-foreground/40')}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-1.5">
                          <span className={cn('flex-1 truncate text-[13px]', active ? 'text-sidebar-foreground font-medium' : 'text-sidebar-foreground/85')}>
                            {s.title || s.preview || 'Brain chat'}
                          </span>
                          <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                            {relTime(s.lastMessageAt ?? s.startedAt)}
                          </span>
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

export function AppSidebar() {
  const pathname = usePathname();
  const search = useSearchParams();
  const { mobileOpen, setMobileOpen, collapsed, setCollapsed } = useSidebar();
  const onChat = pathname.startsWith('/chat');
  const onAgents = pathname.startsWith('/agents');
  const onCron = pathname.startsWith('/cron');
  const onSkills = pathname.startsWith('/skills');
  const onUsage = pathname.startsWith('/usage');
  const onOps = pathname.startsWith('/ops');
  const onMarket = pathname.startsWith('/market');
  const onBrain = pathname.startsWith('/brain');
  const onBrainChat = pathname === '/brain'; // the Chat view (no sub-route; ?session= keeps this path)
  // When viewing a chat session, point the Agents nav at THAT session's agent, so
  // entering Agents from a session lands on its agent instead of the default
  // first-agent. Reuses RecentSessions' listSessions query (same key → deduped).
  const currentSessionId = onChat ? search.get('session') : null;
  const sidebarSessions = trpc.chat.listSessions.useQuery({}, { enabled: !!currentSessionId });
  const currentSessionAgent = currentSessionId
    ? sidebarSessions.data?.find((s) => s.id === currentSessionId)?.agentName ?? null
    : null;
  // Route-aware primary CTA: New agent on /agents, New cron on /cron, New skill
  // on /skills, else New chat.
  const cta = onAgents
    ? { href: '/agents?new=1', label: 'New agent', Icon: Plus }
    : onCron
      ? { href: '/cron?new=1', label: 'New cron', Icon: Plus }
      : onSkills
        ? { href: '/skills?new=1', label: 'New skill', Icon: Plus }
        : { href: '/chat?new=1', label: 'New chat', Icon: SquarePen };
  // Shared chrome for the CTA-styled buttons (Market entry, Dashboard back, New-X).
  const ctaCls = cn(
    'flex items-center gap-2 rounded-lg h-9 text-sm font-medium transition-colors cursor-pointer',
    'border border-sidebar-border bg-sidebar hover:bg-sidebar-accent text-sidebar-foreground',
    collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3',
  );

  // Close the mobile drawer on navigation. Selecting a session/agent/cron only
  // changes the query string (?session= / ?name= / ?id=), not the pathname, so
  // key on the full location — otherwise the drawer stays open over the content
  // the user just tapped. (Swipe-open doesn't navigate, so it won't trip this.)
  const locationKey = `${pathname}?${search.toString()}`;
  useEffect(() => { setMobileOpen(false); }, [locationKey, setMobileOpen]);
  // Escape closes the mobile drawer.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, setMobileOpen]);

  // ── Interactive swipe to open / close the mobile drawer ──────────────────────
  // Edge-swipe right (from the left ~28px) opens; swipe left (anywhere) closes.
  // The drawer tracks the finger and snaps open/closed past the halfway point or
  // on a flick. Desktop (lg+) is untouched — isMobile() gates the whole thing,
  // and the sidebar is static there. On release we restore styling to the
  // className so a later button/backdrop toggle still animates normally.
  const asideRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const mobileOpenRef = useRef(mobileOpen);
  mobileOpenRef.current = mobileOpen;
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;
    const backdrop = backdropRef.current;
    const W = 280;     // drawer width (matches w-[280px])
    const EDGE = 28;   // left-edge zone that can start an OPEN gesture
    const SLOP = 10;   // px of travel before we commit to horizontal vs vertical

    let mode: 'open' | 'close' | null = null;
    let startX = 0, startY = 0, lastX = 0, lastT = 0, vx = 0, curTx = 0;
    let decided = false, engaged = false, clearTimer = 0;

    const isMobile = () => window.matchMedia('(max-width: 1023px)').matches;

    const paint = (tx: number) => {
      curTx = tx;
      aside.style.transition = 'none';
      aside.style.transform = `translateX(${tx}px)`;
      if (backdrop) {
        const p = Math.max(0, Math.min(1, (tx + W) / W));
        backdrop.style.transition = 'none';
        backdrop.style.opacity = String(p);
        backdrop.style.pointerEvents = p > 0.01 ? 'auto' : 'none';
      }
    };
    const restore = () => {
      aside.style.transition = '';
      aside.style.transform = '';
      if (backdrop) { backdrop.style.transition = ''; backdrop.style.opacity = ''; backdrop.style.pointerEvents = ''; }
    };

    const onStart = (e: TouchEvent) => {
      if (clearTimer) { window.clearTimeout(clearTimer); clearTimer = 0; }
      if (!isMobile() || e.touches.length !== 1) { mode = null; return; }
      const t = e.touches[0];
      if (mobileOpenRef.current) mode = 'close';
      else if (t.clientX <= EDGE) mode = 'open';
      else { mode = null; return; }
      startX = lastX = t.clientX; startY = t.clientY; lastT = e.timeStamp;
      decided = false; engaged = false; vx = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (mode === null) return;
      const t = e.touches[0];
      const dx = t.clientX - startX, dy = t.clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        decided = true;
        const rightDir = mode === 'open' ? dx > 0 : dx < 0;
        engaged = Math.abs(dx) > Math.abs(dy) && rightDir;
        if (!engaged) { mode = null; return; } // a vertical scroll — let it through
      }
      e.preventDefault(); // we own this horizontal gesture; block page scroll
      const now = e.timeStamp;
      if (now > lastT) vx = (t.clientX - lastX) / (now - lastT);
      lastX = t.clientX; lastT = now;
      const base = mode === 'open' ? -W : 0;
      paint(Math.max(-W, Math.min(0, base + dx)));
    };
    const onEnd = () => {
      if (mode === null || !engaged) { mode = null; return; }
      const p = (curTx + W) / W;                       // 0 closed → 1 open
      const open = Math.abs(vx) > 0.3 ? vx > 0 : p > 0.5; // flick wins, else halfway
      aside.style.transition = '';                     // re-enable the CSS transition
      aside.style.transform = open ? 'translateX(0)' : `translateX(-${W}px)`;
      if (backdrop) { backdrop.style.transition = ''; backdrop.style.opacity = open ? '1' : '0'; backdrop.style.pointerEvents = open ? 'auto' : 'none'; }
      setMobileOpen(open);
      clearTimer = window.setTimeout(restore, 240); // hand control back to className
      mode = null; engaged = false;
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      if (clearTimer) window.clearTimeout(clearTimer);
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [setMobileOpen]);

  return (
    <>
      {/* mobile backdrop */}
      <div
        ref={backdropRef}
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
        className={cn(
          'lg:hidden fixed inset-0 z-40 bg-foreground/20 transition-opacity duration-150',
          mobileOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
      />
      <aside
        ref={asideRef}
        aria-label="navigation"
        className={cn(
          'bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col shrink-0',
          // mobile: fixed off-canvas drawer. pwa-safe-* keeps the drawer's header
          // below the iOS status bar + its footer above the home indicator when
          // installed (standalone); a normal browser tab is unaffected.
          'fixed inset-y-0 left-0 z-50 w-[280px] transition-transform duration-200 ease-out pwa-safe-t pwa-safe-b',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          // desktop: in-flow, width animates on collapse
          'lg:static lg:translate-x-0 lg:z-0 lg:transition-[width] lg:duration-200',
          collapsed ? 'lg:w-[60px]' : 'lg:w-[300px]',
        )}
      >
        {/* Header: workspace switcher + collapse toggle */}
        <div className={cn('flex items-center gap-1 h-12 px-2 shrink-0', collapsed && 'lg:justify-center')}>
          {/* Same row: dashboard mode = [machine selector][🏪 market icon];
              market mode = [← back icon][Market label]. Entry + back are icons. */}
          {onMarket ? (
            <>
              <Link
                href="/chat"
                title="Back to dashboard"
                aria-label="back to dashboard"
                className="inline-flex items-center justify-center p-1.5 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors cursor-pointer shrink-0"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <div className={cn('flex-1 min-w-0', collapsed && 'lg:hidden')}>
                <span className="px-1 text-sm font-semibold text-sidebar-foreground">Market</span>
              </div>
            </>
          ) : onBrain ? (
            <>
              <Link
                href="/chat"
                title="Back to dashboard"
                aria-label="back to dashboard"
                className="inline-flex items-center justify-center p-1.5 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors cursor-pointer shrink-0"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <Link
                href="/brain"
                className={cn('flex flex-1 min-w-0 items-center gap-1.5 rounded-md px-1 py-1 hover:bg-sidebar-accent/60 transition-colors cursor-pointer', collapsed && 'lg:hidden')}
              >
                <span aria-hidden="true" className="logo-crab-mono h-4 w-4 shrink-0 bg-sidebar-foreground" />
                <span className="text-sm font-semibold text-sidebar-foreground">Brain</span>
              </Link>
            </>
          ) : (
            <>
              {/* "Hermit" wordmark on the left (Cochin PNG → CSS mask filled with
                  bg-sidebar-foreground, so it follows the theme), links home. The
                  crab is no longer paired here — it became the Brain button on the
                  right (planned 义脑 feature), next to Market. All hide on the
                  collapsed rail so only the toggle shows. */}
              <Link
                href="/chat"
                aria-label="Hermit home"
                className={cn(
                  // pl-3 so the wordmark's left edge lines up with the "New chat"
                  // icon below it (header px-2 = 8px + pl-3 = 12px → 20px, matching
                  // the CTA container px-2 + the CTA button's px-3).
                  'flex flex-1 min-w-0 items-center rounded-md pl-3 pr-1 py-1 hover:bg-sidebar-accent/60 transition-colors cursor-pointer',
                  collapsed && 'lg:hidden',
                )}
              >
                <span
                  aria-hidden="true"
                  className="wordmark-hermit shrink-0 bg-sidebar-foreground"
                  style={{ width: 76, height: 19 }}
                />
              </Link>
              <BrainButton collapsed={collapsed} />
              <Link
                href="/market/skills"
                title="Public marketplace"
                aria-label="public marketplace"
                className={cn(
                  'inline-flex items-center justify-center p-1.5 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors cursor-pointer shrink-0',
                  collapsed && 'lg:hidden',
                )}
              >
                <Store className="h-4 w-4" />
              </Link>
            </>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'expand sidebar' : 'collapse sidebar'}
            title={collapsed ? 'expand' : 'collapse'}
            className="hidden lg:inline-flex p-1.5 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors cursor-pointer shrink-0"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>

        {onMarket ? (
          /* Market mode: Skills/Templates nav (back lives in the header). */
          <>
            <nav className="px-2 pt-2 space-y-0.5">
              {MARKET_NAV.map((n) => {
                const active = pathname.startsWith(n.href);
                const Icon = n.icon;
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    title={n.label}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg h-8 text-sm transition-colors cursor-pointer',
                      collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3',
                      active
                        ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
                        : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className={cn('truncate', collapsed && 'lg:hidden')}>{n.label}</span>
                  </Link>
                );
              })}
            </nav>
            <div className="flex-1" />
          </>
        ) : onBrain ? (
          /* Brain mode: its own menu (Chat / Memory / Dispatches). The Chat view
             also shows New chat + the brain's conversations below the menu. */
          <>
            <nav className="px-2 pt-2 space-y-0.5">
              {BRAIN_NAV.map((n) => {
                const active = n.href === '/brain' ? onBrainChat : pathname.startsWith(n.href);
                const Icon = n.icon;
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    title={n.label}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg h-8 text-sm transition-colors cursor-pointer',
                      collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3',
                      active
                        ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
                        : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className={cn('truncate', collapsed && 'lg:hidden')}>{n.label}</span>
                  </Link>
                );
              })}
            </nav>
            {onBrainChat ? <BrainSidebar collapsed={collapsed} /> : <div className="flex-1" />}
          </>
        ) : (
          <>
            {/* Primary CTA — route-aware (New agent / New cron / New chat). */}
            <div className="px-2">
              <Link href={cta.href} title={cta.label} className={ctaCls}>
                <cta.Icon className="h-4 w-4 shrink-0" />
                <span className={cn('truncate', collapsed && 'lg:hidden')}>{cta.label}</span>
              </Link>
            </div>

            {/* Primary nav */}
            <nav className="px-2 pt-2 space-y-0.5">
              {NAV.map((n) => {
                const active = n.href === '/chat' ? onChat : n.href === '/skills' ? (onSkills || onUsage || onOps) : pathname.startsWith(n.href);
                const Icon = n.icon;
                // From a chat session, the Agents entry deep-links to that session's agent.
                const href = n.href === '/agents' && currentSessionAgent
                  ? `/agents?name=${encodeURIComponent(currentSessionAgent)}`
                  : n.href;
                return (
                  <Link
                    key={n.href}
                    href={href}
                    title={n.label}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg h-8 text-sm transition-colors cursor-pointer',
                      collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3',
                      active
                        ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
                        : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className={cn('truncate', collapsed && 'lg:hidden')}>{n.label}</span>
                  </Link>
                );
              })}
            </nav>

            {/* Recents — sessions on /chat, agents on /agents. Hidden when collapsed. */}
            {!collapsed && onChat && <RecentSessions />}
            {!collapsed && onAgents && <RecentAgents />}
            {!collapsed && onCron && <RecentCrons />}
            {/* The global-skill list now lives in the page (Settings → Global Skills),
                not the sidebar — so /skills falls through to the spacer below. */}
            {(collapsed || (!onChat && !onAgents && !onCron)) && <div className="flex-1" />}
          </>
        )}

        {/* Footer: machine switcher (switch / add / remove machines). Replaced the
            static machine name + a sign-out button — there are no accounts to sign
            out of, and the brand mark took over the header's top-left. */}
        <div className="border-t border-sidebar-border p-2 mt-auto shrink-0">
          <WorkspaceSwitcher collapsed={collapsed} />
        </div>
      </aside>
    </>
  );
}

// Agent list shown in the sidebar on /agents. Mirrors RecentSessions visually
// so the two routes feel like the same chrome with a different payload.
// Shared sidebar search box — a quick title/name filter over a list (Agents /
// Crons), mirroring the Recents search on /chat. Esc clears.
function SidebarFindInput({ value, onChange, placeholder, label }: {
  value: string; onChange: (v: string) => void; placeholder: string; label: string;
}) {
  return (
    <div className="px-2 pb-1">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" aria-hidden="true" />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onChange(''); }}
          placeholder={placeholder}
          aria-label={label}
          className="h-8 w-full rounded-lg border border-sidebar-border bg-sidebar/60 pl-7 pr-2 text-[12px] text-sidebar-foreground/90 placeholder:text-muted-foreground/50 outline-none transition-colors hover:border-sidebar-foreground/20 focus-visible:border-sidebar-foreground/40 focus-visible:ring-1 focus-visible:ring-sidebar-foreground/15"
        />
      </div>
    </div>
  );
}

function RecentAgents() {
  const search = useSearchParams();
  const activeName = search.get('name');
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 10_000 });
  const pending = trpc.agents.pendingRequests.useQuery(undefined, { refetchInterval: 2_000 });
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
                          <span>{a.skillNames.length} skill{a.skillNames.length === 1 ? '' : 's'}</span>
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

// Recycle bin pinned to the bottom of the agents sidebar: agents that were
// soft-deleted (their dir moved to .hermit-trash) but not yet purged. Collapsed
// by default; restore moves an agent back, purge is a two-step permanent delete.
function TrashedAgents() {
  const trashed = trpc.agents.listTrashed.useQuery(undefined, { refetchInterval: 15_000 });
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const refresh = () => {
    void utils.agents.list.invalidate();
    void utils.agents.listTrashed.invalidate();
    void utils.agents.pendingRequests.invalidate();
  };
  const restore = trpc.agents.requestRestore.useMutation({ onSuccess: refresh });
  const purge = trpc.agents.requestPurge.useMutation({ onSuccess: refresh });
  const items = trashed.data ?? [];
  if (items.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-sidebar-border/60 pt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full px-3 py-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70 hover:text-muted-foreground cursor-pointer"
      >
        <Trash2 className="h-3 w-3" />
        <span>Recycle bin</span>
        <span className="tabular-nums text-muted-foreground/50">{items.length}</span>
        <ChevronDown className={cn('ml-auto h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="px-2 pb-2 space-y-px max-h-52 overflow-y-auto">
          {items.map((a) => (
            <li
              key={a.id}
              className="group flex items-center gap-1 rounded-lg px-2.5 py-1.5 hover:bg-sidebar-accent/40"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-mono text-sidebar-foreground/55 line-through decoration-muted-foreground/40">
                  {a.name}
                </div>
                {a.trashedAt && (
                  <div className="text-[10px] font-mono text-muted-foreground/50 tabular-nums">
                    deleted {relTime(a.trashedAt)}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => restore.mutate({ name: a.name })}
                disabled={restore.isPending}
                title={`restore ${a.name}`}
                aria-label={`restore ${a.name}`}
                className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:bg-sidebar-accent hover:text-emerald-600 transition-colors cursor-pointer disabled:opacity-40"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <PurgeButton name={a.name} onConfirm={() => purge.mutate({ name: a.name })} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Two-step permanent delete: first click arms, second confirms; auto-disarms
// after 3.5s. Mirrors the header ConfirmDeleteButton on the agents page.
function PurgeButton({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed) {
    return (
      <span className="shrink-0 inline-flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => { setArmed(false); onConfirm(); }}
          title={`permanently delete ${name}`}
          aria-label={`permanently delete ${name}`}
          className="inline-flex items-center justify-center h-6 w-6 rounded text-rose-600 hover:bg-rose-500/10 cursor-pointer"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          aria-label="cancel"
          className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:bg-sidebar-accent cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      title={`permanently delete ${name}`}
      aria-label={`permanently delete ${name}`}
      className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 transition-colors cursor-pointer"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}

function fmtEvery(sec: number): string {
  if (sec % 3600 === 0) return `every ${sec / 3600}h`;
  if (sec % 60 === 0) return `every ${sec / 60}m`;
  return `every ${sec}s`;
}

// Cron list shown in the sidebar on /cron — all scheduled tasks across agents.
// Mirrors RecentSessions/RecentAgents so the chrome reads the same.
function RecentCrons() {
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
                : c.lastStatus === 'fail'
                  ? 'bg-rose-500'
                  : c.lastStatus === 'running'
                    ? 'bg-amber-500'
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

// Global-skill list shown in the sidebar on /skills — ~/.claude/skills/ on the
// gateway host. Mirrors RecentCrons so the chrome reads the same.
function RecentSkills() {
  const search = useSearchParams();
  const activeName = search.get('name');
  const skills = trpc.skills.list.useQuery(undefined, { refetchInterval: 10_000 });
  const pending = trpc.skills.pendingRequests.useQuery(undefined, { refetchInterval: 2_000 });
  const pendingCreates = (pending.data ?? []).filter((p) => p.kind === 'create');

  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>Skills</span>
        <span className="tabular-nums text-muted-foreground/50">{skills.data?.length ?? 0}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {skills.isPending ? (
          <div className="space-y-1 px-1 pt-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 rounded-md bg-sidebar-accent/40 animate-pulse" />
            ))}
          </div>
        ) : (skills.data?.length ?? 0) === 0 && pendingCreates.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">no global skills yet — start with “New skill”.</p>
        ) : (
          <ul className="space-y-px">
            {skills.data?.map((s) => {
              const active = activeName === s.name;
              const dot = s.isBundle
                ? 'bg-violet-500'
                : s.source === 'git'
                  ? 'bg-sky-500'
                  : s.source === 'plugin'
                    ? 'bg-violet-500'
                    : 'bg-emerald-500';
              return (
                <li key={s.id}>
                  <Link
                    href={`/skills?name=${encodeURIComponent(s.name)}`}
                    className={cn(
                      'group block w-full rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors',
                      active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
                    )}
                    title={s.description || s.name}
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <span className={cn('mt-1.5 h-1.5 w-1.5 rounded-full shrink-0', dot)} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-1.5">
                          <span className={cn('flex-1 truncate text-[13px] font-mono', active ? 'text-sidebar-foreground font-medium' : 'text-sidebar-foreground/85')}>
                            {s.name}
                          </span>
                          <span className="shrink-0 text-[10px] font-mono text-muted-foreground/60 tabular-nums">
                            {s.isBundle ? 'bundle' : s.source}
                          </span>
                        </div>
                        {s.description && (
                          <div className="mt-0.5 truncate text-[10px] text-muted-foreground/75">{s.description}</div>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
            {pendingCreates.map((p) => (
              <li key={p.id} className="px-2.5 py-1.5 opacity-70">
                <div className="flex items-start gap-2 min-w-0">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 border border-muted-foreground/40" aria-hidden="true" />
                  <div className="flex-1 min-w-0 flex items-baseline justify-between gap-1.5">
                    <span className="flex-1 truncate text-[13px] font-mono text-sidebar-foreground/70">{p.skillName}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/60 animate-pulse">creating…</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RecentSessions() {
  const search = useSearchParams();
  const activeId = search.get('session');
  const sessions = trpc.chat.listSessions.useQuery({}, { refetchInterval: 5_000 });
  // The orchestrator (义脑) lives in /brain — keep its conversations out of the
  // worker session recents. agents.list is cached (shared), so this is cheap.
  const orchestratorsQ = trpc.agents.list.useQuery(undefined, { staleTime: 60_000 });
  const orchestratorName = (orchestratorsQ.data ?? []).find((a) => a.isOrchestrator)?.name;
  const utils = trpc.useUtils();
  const liveWorkingSince = useLiveWorking();
  const pins = usePins();
  // Custom right-click menu: viewport coords + the session it targets, or null.
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // Touch long-press opens the SAME menu — phones have no right-click.
  const openMenuAt = useCallback((id: string, x: number, y: number) => setMenu({ x, y, id }), []);
  const longPress = useLongPress(openMenuAt);

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
    sessions.data?.forEach((s) => { if (s.agentName !== orchestratorName) names.add(s.agentName); });
    return Array.from(names).sort();
  }, [sessions.data, orchestratorName]);
  const visible = useMemo(() => {
    let rows = (sessions.data ?? []).filter((s) => s.agentName !== orchestratorName);
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
  }, [sessions.data, filter, q, pins, orchestratorName]);

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
          ]}
        />
      )}
      {(sessions.data?.length ?? 0) > 0 && (
        <div className="px-2 pb-1 flex items-center gap-1.5">
          {/* Left: a simple title/agent text search over the recents list. */}
          <div className="relative flex-1 min-w-0">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" aria-hidden="true" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }}
              placeholder="搜索标题 / agent"
              aria-label="search recents by title or agent"
              className="h-8 w-full rounded-lg border border-sidebar-border bg-sidebar/60 pl-7 pr-2 text-[12px] text-sidebar-foreground/90 placeholder:text-muted-foreground/50 outline-none transition-colors hover:border-sidebar-foreground/20 focus-visible:border-sidebar-foreground/40 focus-visible:ring-1 focus-visible:ring-sidebar-foreground/15"
            />
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
            {visible.map((s) => {
              const active = activeId === s.id;
              // Optimistic working: the moment the user sends, the session is
              // marked live (markSessionWorking) so this dot turns yellow
              // instantly — no waiting ~13s for the gateway snapshot + 5s poll.
              // Reconcile with the gateway's truth: once it snapshots the pane
              // AFTER the send (snapshotAt > stamp), drop the optimism and let
              // the real `state` drive the dot.
              const liveAt = liveWorkingSince(s.id);
              const optimisticWorking =
                liveAt != null && (!s.snapshotAt || new Date(s.snapshotAt).getTime() < liveAt);
              const status = sessionStatusView(s, {
                unread: isSessionUnread(s),
                liveWorking: optimisticWorking,
              });
              return (
                <li key={s.id}>
                  <Link
                    href={`/chat?session=${encodeURIComponent(s.id)}`}
                    onMouseEnter={() => prefetchSession(s.id)}
                    onFocus={() => prefetchSession(s.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, id: s.id });
                    }}
                    {...longPress(s.id)}
                    className={cn(
                      'group block w-full rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors select-none [-webkit-touch-callout:none]',
                      active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
                      s.closedAt && 'opacity-60',
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
                          {pins.has(s.id) && (
                            <Pin className="h-3 w-3 shrink-0 self-center -rotate-45 fill-current text-muted-foreground/70" aria-label="pinned" />
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
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
