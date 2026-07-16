'use client';

import { trpc } from '@/lib/trpc';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { AgentFiles } from '@/components/agent-files';

// Brain · Files — the raw workspace file manager for the orchestrator agent
// (browse / edit / upload its whole directory). The curated memory view lives at
// /brain/memory.
export default function BrainFilesPage() {
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 30_000 });
  const brain = (agents.data ?? []).find((a) => a.isOrchestrator);
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span aria-hidden className="logo-crab-mono h-5 w-5 bg-foreground" />
        <span className="text-sm font-medium text-foreground">Brain · Files</span>
      </header>
      {agents.isPending ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">loading…</div>
      ) : brain ? (
        <div className="flex flex-1 min-h-0 flex-col">
          <AgentFiles key={brain.name} agentName={brain.name} directory={brain.directory} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          No Brain yet — set one up from the Chat tab.
        </div>
      )}
    </div>
  );
}
