'use client';

import { trpc } from '@/lib/trpc';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { AgentFiles } from '@/components/agent-files';

// Brain · Memory — manage the brain's files (its memory/ dossiers + daily logs
// live here). Reuses the agent file manager scoped to the orchestrator agent.
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
