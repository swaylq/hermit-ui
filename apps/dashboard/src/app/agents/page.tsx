'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { AgentDetailSheet } from '@/components/agent-detail-sheet';
import { fmtBytes, ctxPct, relTime, stateColor } from '@/lib/format';

export default function AgentsPage() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 5000 });

  return (
    <div className="max-w-3xl w-full mx-auto p-4 sm:p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
        <p className="text-xs text-muted-foreground mt-1 tabular-nums">
          {agents.data?.length ?? 0} on this machine · tap to inspect, or open a chat
        </p>
      </div>

      <div className="border border-border rounded-md overflow-hidden divide-y divide-border">
        {agents.isPending ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : (
          agents.data?.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              onOpenDetail={() => setSelectedAgent(a.name)}
            />
          ))
        )}
      </div>

      <AgentDetailSheet
        open={!!selectedAgent}
        onOpenChange={(b) => !b && setSelectedAgent(null)}
        name={selectedAgent}
      />
    </div>
  );
}

function AgentRow({ agent, onOpenDetail }: { agent: any; onOpenDetail: () => void }) {
  const c = stateColor(agent.state, agent.alive);
  const pct = ctxPct(agent.contextTokens);
  const initials = agent.name.slice(0, 2).toUpperCase();

  return (
    <div className="group relative flex items-center gap-3 px-3 py-3 transition-colors hover:bg-accent/50">
      <div
        className={`h-8 w-8 rounded-md bg-muted text-muted-foreground flex items-center justify-center font-mono text-[10px] font-medium shrink-0 group-hover:text-foreground transition-colors ${
          agent.alive ? '' : 'opacity-50'
        }`}
        aria-hidden="true"
      >
        {initials}
      </div>

      <button
        onClick={onOpenDetail}
        className="flex-1 min-w-0 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm truncate text-foreground">{agent.name}</span>
          <span className="text-[10px] font-mono text-muted-foreground/70 shrink-0 tabular-nums">
            {relTime(agent.lastActivity)}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground mt-0.5">
          <span className="inline-flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
            {agent.alive ? agent.state ?? 'live' : 'down'}
          </span>
          {agent.contextTokens != null && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="tabular-nums">
                ctx <span className="text-foreground/80">{fmtBytes(agent.contextTokens)}</span>{' '}
                <span className={pct >= 80 ? 'text-rose-500' : pct >= 50 ? 'text-amber-500' : 'text-muted-foreground/60'}>
                  ({pct.toFixed(0)}%)
                </span>
              </span>
            </>
          )}
        </div>
      </button>

      <Link
        href={`/chat?agent=${encodeURIComponent(agent.name)}`}
        className="shrink-0 inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-xs"
        aria-label={`chat with ${agent.name}`}
        onClick={(e) => e.stopPropagation()}
        title={`chat with ${agent.name}`}
      >
        →
      </Link>
    </div>
  );
}
