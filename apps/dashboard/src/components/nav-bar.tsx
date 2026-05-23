'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { AsstLogomark } from '@/components/asst-logomark';

type MachineInfo = { name: string; hostname?: string | null; keyPrefix?: string };

export function NavBar({ machine, onLogout }: { machine?: MachineInfo; onLogout: () => void }) {
  const pathname = usePathname();
  const tabs: Array<{ href: string; label: string }> = [
    { href: '/chat', label: 'Chat' },
    { href: '/agents', label: 'Agents' },
    { href: '/usage', label: 'Usage' },
  ];

  return (
    <header className="border-b border-border bg-background sticky top-0 z-20">
      <div className="w-full px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-5 min-w-0">
          <Link
            href="/chat"
            className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="asst home"
          >
            <AsstLogomark />
          </Link>
          <nav className="flex items-center">
            {tabs.map((t) => {
              const active = pathname === t.href || (t.href !== '/agents' && pathname.startsWith(t.href));
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  className={
                    'px-3 py-1.5 text-sm transition-colors ' +
                    (active
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground')
                  }
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3 min-w-0">
          {machine && (
            <span className="text-[10px] font-mono text-muted-foreground/70 truncate hidden sm:inline">
              {machine.name}
            </span>
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onLogout}>
            sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
