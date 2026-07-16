'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  SquarePen, MessageSquare, Bot, Clock, Boxes, PanelLeft, Plus,
  Store, Bell, ArrowLeft, Package, NotebookText, Send, Folder, Moon, BookOpen, Drama, type LucideIcon,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { SETTINGS_HREFS, SETTINGS_TABS } from '@/lib/settings-nav';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { BrainButton, SettingsButton, NotificationsButton } from '@/components/sidebar/header-buttons';
import { BrainSidebar, RecentDispatchSessions } from '@/components/sidebar/brain-sidebar';
import { KnowledgeSidebarList } from '@/components/sidebar/knowledge-sidebar-list';
import { useSidebar, SidebarProvider, SidebarMobileToggle } from '@/components/sidebar/context';
import { RecentCrons, RecentAgents, RecentSessions } from '@/components/sidebar/recent-lists';

// Re-export the sidebar context/provider API (moved to components/sidebar/context)
// so the @/components/app-sidebar barrel stays intact for its ~18 external consumers.
export { useSidebar, SidebarProvider, SidebarMobileToggle };

const NAV: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/cron', label: 'Cron', icon: Clock },
  { href: '/knowledge', label: 'Knowledge', icon: BookOpen },
  // Settings' entry lives in the sidebar HEADER now (the gear next to Brain), not
  // in this list — see SettingsButton.
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
  { href: '/brain/persona', label: 'Persona', icon: Drama },
  { href: '/brain/dream', label: 'Dream', icon: Moon },
  { href: '/brain/files', label: 'Files', icon: Folder },
  { href: '/brain/dispatch', label: 'Dispatches', icon: Send },
];

// Notifications mode: filter the unread inbox by source. Counts come from
// notifications.counts; the page filters the already-loaded feed client-side.
const NOTIF_FILTERS: Array<{ key: 'all' | 'chat' | 'cron'; href: string; label: string; icon: LucideIcon }> = [
  { key: 'all', href: '/notifications', label: 'All', icon: Bell },
  { key: 'chat', href: '/notifications?filter=chat', label: 'Chat', icon: MessageSquare },
  { key: 'cron', href: '/notifications?filter=cron', label: 'Cron', icon: Clock },
];

export function AppSidebar() {
  const pathname = usePathname();
  const search = useSearchParams();
  const { mobileOpen, setMobileOpen, collapsed, setCollapsed } = useSidebar();
  const onChat = pathname.startsWith('/chat');
  const onAgents = pathname.startsWith('/agents');
  const onCron = pathname.startsWith('/cron');
  const onKnowledge = pathname.startsWith('/knowledge');
  const onSkills = pathname.startsWith('/skills');
  // Any Settings route → the sidebar switches to Settings mode (its own vertical nav
  // of the settings tabs), mirroring Market / Brain mode.
  const onSettings = SETTINGS_HREFS.some((h) => pathname === h || pathname.startsWith(h + '/'));
  const onMarket = pathname.startsWith('/market');
  const onBrain = pathname.startsWith('/brain');
  const onBrainChat = pathname === '/brain'; // the Chat view (no sub-route; ?session= keeps this path)
  const onBrainDispatch = pathname.startsWith('/brain/dispatch'); // dispatch list lives in the sidebar too
  const onNotifications = pathname.startsWith('/notifications');
  // Unread roll-up for the bell badge + the notifications-mode filter counts. A
  // machineProcedure → only ever runs for the owner (scoped keys get ScopedSidebar,
  // never this component), so it's safe to call unconditionally.
  const notifCounts = trpc.notifications.counts.useQuery(undefined, { refetchInterval: 5_000 }).data ?? { chat: 0, cron: 0, total: 0 };
  const notifFilter = onNotifications ? (search.get('filter') ?? 'all') : 'all';
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
      : onKnowledge
        ? { href: '/knowledge?new=1', label: 'New knowledge base', Icon: Plus }
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
          ) : onNotifications ? (
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
                <span className="px-1 text-sm font-semibold text-sidebar-foreground">Notifications</span>
              </div>
            </>
          ) : onSettings ? (
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
                <span className="px-1 text-sm font-semibold text-sidebar-foreground">Settings</span>
              </div>
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
              <NotificationsButton collapsed={collapsed} count={notifCounts.total} />
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
              <SettingsButton collapsed={collapsed} />
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
            {onBrainChat ? (
              <BrainSidebar collapsed={collapsed} />
            ) : onBrainDispatch ? (
              <RecentDispatchSessions />
            ) : (
              <div className="flex-1" />
            )}
          </>
        ) : onNotifications ? (
          /* Notifications mode: All / Chat / Cron filters with unread counts. The
             list + "Mark all read" live on the page; this is just the source filter. */
          <>
            <nav className="px-2 pt-2 space-y-0.5">
              {NOTIF_FILTERS.map((f) => {
                const active = notifFilter === f.key;
                const Icon = f.icon;
                const count = f.key === 'all' ? notifCounts.total : f.key === 'chat' ? notifCounts.chat : notifCounts.cron;
                return (
                  <Link
                    key={f.key}
                    href={f.href}
                    title={f.label}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg h-8 text-sm transition-colors cursor-pointer',
                      collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3',
                      active
                        ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
                        : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className={cn('truncate flex-1', collapsed && 'lg:hidden')}>{f.label}</span>
                    {count > 0 && (
                      <span
                        className={cn(
                          'shrink-0 inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-mono tabular-nums leading-none',
                          collapsed && 'lg:hidden',
                        )}
                      >
                        {count}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>
            <div className="flex-1" />
          </>
        ) : onSettings ? (
          /* Settings mode: the settings tabs as a vertical nav (back in the header). */
          <>
            <nav className="px-2 pt-2 space-y-0.5">
              {SETTINGS_TABS.map((t) => {
                const active = pathname === t.href || pathname.startsWith(t.href + '/');
                const Icon = t.Icon;
                return (
                  <Link
                    key={t.href}
                    href={t.href}
                    title={t.label}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg h-8 text-sm transition-colors cursor-pointer',
                      collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3',
                      active
                        ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
                        : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className={cn('truncate', collapsed && 'lg:hidden')}>{t.label}</span>
                  </Link>
                );
              })}
            </nav>
            <div className="flex-1" />
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
                const active = n.href === '/chat' ? onChat : pathname.startsWith(n.href);
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
            {!collapsed && onKnowledge && <KnowledgeSidebarList />}
            {/* The global-skill list now lives in the page (Settings → Global Skills),
                not the sidebar — so /skills falls through to the spacer below. */}
            {(collapsed || (!onChat && !onAgents && !onCron && !onKnowledge)) && <div className="flex-1" />}
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
