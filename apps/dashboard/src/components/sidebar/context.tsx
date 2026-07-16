'use client';

// Sidebar open/collapse state — the React context, its provider, and the mobile
// hamburger toggle. Extracted verbatim from app-sidebar.tsx (P2-4); behaviour
// identical. Re-exported from @/components/app-sidebar so that barrel stays
// intact for its ~18 consumers. useSidebar / SidebarProvider / SidebarMobileToggle
// are the public API; SidebarCtx and Ctx stay module-private.

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { MenuIcon } from 'lucide-react';

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
