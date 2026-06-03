'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  SquarePen, MessageSquare, Bot, BarChart3, Clock, Boxes, PanelLeft, LogOut, MenuIcon, Plus,
  Trash2, RotateCcw, ChevronDown, Check, X, type LucideIcon,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { sessionStatusView } from '@/lib/session-status';
import { useUnread } from '@/lib/session-read';

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

type MachineInfo = { name: string; hostname?: string | null; keyPrefix?: string };

const NAV: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/cron', label: 'Cron', icon: Clock },
  { href: '/skills', label: 'Skills', icon: Boxes },
  { href: '/usage', label: 'Usage', icon: BarChart3 },
];

export function AppSidebar({ machine, onLogout }: { machine?: MachineInfo; onLogout: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const { mobileOpen, setMobileOpen, collapsed, setCollapsed } = useSidebar();
  const onChat = pathname.startsWith('/chat');
  const onAgents = pathname.startsWith('/agents');
  const onCron = pathname.startsWith('/cron');
  const onSkills = pathname.startsWith('/skills');
  // Route-aware primary CTA: New agent on /agents, New cron on /cron, New skill
  // on /skills, else New chat.
  const cta = onAgents
    ? { href: '/agents?new=1', label: 'New agent', Icon: Plus }
    : onCron
      ? { href: '/cron?new=1', label: 'New cron', Icon: Plus }
      : onSkills
        ? { href: '/skills?new=1', label: 'New skill', Icon: Plus }
        : { href: '/chat?new=1', label: 'New chat', Icon: SquarePen };

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
          // mobile: fixed off-canvas drawer
          'fixed inset-y-0 left-0 z-50 w-[280px] transition-transform duration-200 ease-out',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          // desktop: in-flow, width animates on collapse
          'lg:static lg:translate-x-0 lg:z-0 lg:transition-[width] lg:duration-200',
          collapsed ? 'lg:w-[60px]' : 'lg:w-[300px]',
        )}
      >
        {/* Header: workspace switcher + collapse toggle */}
        <div className={cn('flex items-center gap-1 h-12 px-2 shrink-0', collapsed && 'lg:justify-center')}>
          <div className={cn('flex-1 min-w-0', collapsed && 'lg:hidden')}>
            <WorkspaceSwitcher collapsed={collapsed} />
          </div>
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

        {/* Primary CTA — route-aware (see `cta` above). New agent / New cron /
            New chat share the same chrome so the layout reads consistently. */}
        <div className="px-2">
          <Link
            href={cta.href}
            className={cn(
              'flex items-center gap-2 rounded-lg h-9 text-sm font-medium transition-colors cursor-pointer',
              'border border-sidebar-border bg-sidebar hover:bg-sidebar-accent text-sidebar-foreground',
              collapsed ? 'lg:justify-center lg:px-0 px-3' : 'px-3',
            )}
            title={cta.label}
          >
            <cta.Icon className="h-4 w-4 shrink-0" />
            <span className={cn('truncate', collapsed && 'lg:hidden')}>{cta.label}</span>
          </Link>
        </div>

        {/* Primary nav */}
        <nav className="px-2 pt-2 space-y-0.5">
          {NAV.map((n) => {
            const active = n.href === '/chat' ? onChat : pathname.startsWith(n.href);
            const Icon = n.icon;
            return (
              <Link
                key={n.href}
                href={n.href}
                title={n.label}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg h-9 text-sm transition-colors cursor-pointer',
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
        {!collapsed && onSkills && <RecentSkills />}
        {(collapsed || (!onChat && !onAgents && !onCron && !onSkills)) && <div className="flex-1" />}

        {/* Footer: machine + sign out */}
        <div className="border-t border-sidebar-border p-2 mt-auto shrink-0">
          <div className={cn('flex items-center gap-2', collapsed && 'lg:justify-center')}>
            <div className="h-7 w-7 shrink-0 rounded-full bg-sidebar-accent text-sidebar-foreground flex items-center justify-center text-[11px] font-medium" aria-hidden="true">
              {(machine?.name ?? '?').slice(0, 2).toUpperCase()}
            </div>
            <div className={cn('flex-1 min-w-0', collapsed && 'lg:hidden')}>
              <div className="text-xs font-medium truncate">{machine?.name ?? 'machine'}</div>
              {machine?.hostname && <div className="text-[10px] text-muted-foreground truncate font-mono">{machine.hostname}</div>}
            </div>
            <button
              type="button"
              onClick={onLogout}
              aria-label="sign out"
              title="sign out"
              className={cn('p-1.5 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors cursor-pointer', collapsed && 'lg:hidden')}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

// Agent list shown in the sidebar on /agents. Mirrors RecentSessions visually
// so the two routes feel like the same chrome with a different payload.
function RecentAgents() {
  const search = useSearchParams();
  const activeName = search.get('name');
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 10_000 });
  const pending = trpc.agents.pendingRequests.useQuery(undefined, { refetchInterval: 2_000 });
  const utils = trpc.useUtils();

  // Prefetch byName so picking an agent feels instant (sub-200ms when cached).
  useEffect(() => {
    if (!agents.data) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    agents.data.slice(0, 20).forEach((a, i) => {
      timers.push(setTimeout(() => {
        void utils.agents.byName.prefetch({ name: a.name }, { staleTime: 30_000 });
      }, i * 80));
    });
    return () => timers.forEach(clearTimeout);
  }, [agents.data, utils]);

  const pendingAdds = (pending.data ?? []).filter((p) => p.kind === 'create' || p.kind === 'import');

  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>Agents</span>
        <span className="tabular-nums text-muted-foreground/50">{agents.data?.length ?? 0}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {agents.isPending ? (
          <div className="space-y-1 px-1 pt-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 rounded-md bg-sidebar-accent/40 animate-pulse" />
            ))}
          </div>
        ) : (agents.data?.length ?? 0) === 0 && pendingAdds.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">no agents yet — start with “New agent”.</p>
        ) : (
          <ul className="space-y-px">
            {agents.data?.map((a) => {
              const active = activeName === a.name;
              return (
                <li key={a.id}>
                  <Link
                    href={`/agents?name=${encodeURIComponent(a.name)}`}
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

  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>Crons</span>
        <span className="tabular-nums text-muted-foreground/50">{crons.data?.length ?? 0}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {crons.isPending ? (
          <div className="space-y-1 px-1 pt-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 rounded-md bg-sidebar-accent/40 animate-pulse" />
            ))}
          </div>
        ) : (crons.data?.length ?? 0) === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">no crons yet — start with “New cron”.</p>
        ) : (
          <ul className="space-y-px">
            {crons.data?.map((c) => {
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
  const utils = trpc.useUtils();
  const isUnread = useUnread();

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

  // Prefetch message history for the top sessions so opening one is instant.
  // Key on the session-ID LIST (a value-stable string), NOT the row objects:
  // listSessions' rows get a fresh reference every ~8s snapshot tick (state /
  // contextTokens / snapshotAt churn) — depending on `sessions.data` directly
  // re-fired this whole loop every few seconds, re-fetching every OTHER session's
  // 60-message window on a timer (heavy idle network). The joined-id string only
  // changes when the set/order of sessions actually changes, so idle is quiet and
  // re-prefetch happens only on real activity (a new message reorders the list).
  const prefetchIds = useMemo(
    () => (sessions.data ?? []).slice(0, 8).map((s) => s.id).join(','),
    [sessions.data],
  );
  useEffect(() => {
    if (!prefetchIds) return;
    const timers = prefetchIds.split(',').map((id, i) =>
      setTimeout(() => {
        // limit MUST equal chat/page.tsx INITIAL_WINDOW so the click-to-open
        // query key matches and stays a cache hit (no skeleton flash).
        void utils.chat.listMessages.prefetch({ sessionId: id, limit: 60 }, { staleTime: 60_000 });
      }, i * 80),
    );
    return () => timers.forEach(clearTimeout);
  }, [prefetchIds, utils]);

  const agentNames = useMemo(() => {
    const names = new Set<string>();
    sessions.data?.forEach((s) => names.add(s.agentName));
    return Array.from(names).sort();
  }, [sessions.data]);
  const visible = useMemo(
    () => (filter ? (sessions.data ?? []).filter((s) => s.agentName === filter) : sessions.data ?? []),
    [sessions.data, filter],
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="px-3 pb-1 flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>Recents</span>
        <span className="tabular-nums text-muted-foreground/50">{visible.length}</span>
      </div>
      {agentNames.length > 1 && (
        <div className="px-2 pb-1">
          {/* Custom (non-native) dropdown via base-ui Select — styled to match the
              sidebar so trigger AND the option popup are fully themed. */}
          {/* modal={false}: a filter dropdown must not lock the page — base-ui
              Select defaults modal=true, whose backdrop/scroll-lock left the
              sidebar session links unclickable after an open/close cycle. */}
          <Select value={filter} onValueChange={(v) => onFilterChange(v ?? '')} modal={false}>
            <SelectTrigger
              aria-label="filter sessions by agent"
              className="border-sidebar-border bg-sidebar/60 font-mono text-sidebar-foreground/90 hover:border-sidebar-foreground/20 hover:bg-sidebar-accent/60 focus-visible:border-sidebar-foreground/40 focus-visible:ring-sidebar-foreground/15"
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
            {filter ? `no sessions for ${filter}.` : 'no chats yet — start a New chat.'}
          </p>
        ) : (
          <ul className="space-y-px">
            {visible.map((s) => {
              const active = activeId === s.id;
              const status = sessionStatusView(s, { unread: isUnread(s.id, s.lastMessageAt) });
              return (
                <li key={s.id}>
                  <Link
                    href={`/chat?session=${encodeURIComponent(s.id)}`}
                    className={cn(
                      'group block w-full rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors',
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
