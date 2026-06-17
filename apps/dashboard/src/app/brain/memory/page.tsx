'use client';

import { trpc } from '@/lib/trpc';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { MemoryDir } from '@/components/brain-memory';

// Brain · Memory — a curated view of the brain's OWN memory: its roster and the
// per-agent dossiers. Read from the brain's WORKSPACE memory/ folder (where it
// writes), over the live file-manager bridge. Read-only — Brain curates it via
// the dreaming ritual. (The raw whole-directory file manager is the Files tab.)
const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{children}</div>
);

export default function BrainMemoryPage() {
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 15_000 });
  const brain = (agents.data ?? []).find((a) => a.isOrchestrator);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span aria-hidden className="logo-crab-mono h-5 w-5 bg-foreground" />
        <span className="text-sm font-medium text-foreground">Brain · Memory</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {agents.isPending ? (
          <Centered>loading…</Centered>
        ) : !brain ? (
          <Centered>No Brain yet — set one up from the Chat tab.</Centered>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
            <p className="text-xs text-muted-foreground">
              Brain&apos;s own memory — its roster and per-agent dossiers (dreams have their own tab).
              Brain curates this itself via dreaming and keeps it terse on purpose.
            </p>
            <MemoryDir
              agentName={brain.name}
              dir="memory"
              title="Roster & files"
              labelOf={(n) => (n === 'roster.md' ? 'Roster' : n)}
              emptyHint="Brain hasn't written any memory yet — it builds this as it works and dreams."
            />
            <MemoryDir
              agentName={brain.name}
              dir="memory/agents"
              title="Agent dossiers"
              labelOf={(n) => n.replace(/\.md$/i, '')}
              emptyHint="No dossiers yet."
            />
          </div>
        )}
      </div>
    </div>
  );
}
