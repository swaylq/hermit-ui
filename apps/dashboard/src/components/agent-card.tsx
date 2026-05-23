'use client';

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fmtBytes, ctxPct, relTime, stateColor } from '@/lib/format';

type Agent = {
  id: string;
  name: string;
  pid: number | null;
  alive: boolean;
  state: string | null;
  contextTokens: number | null;
  lastActivity: Date | string | null;
};

export function AgentCard({ agent, onClick, active }: { agent: Agent; onClick?: () => void; active?: boolean }) {
  const pct = ctxPct(agent.contextTokens);
  const c = stateColor(agent.state, agent.alive);
  return (
    <Card
      onClick={onClick}
      className={`p-3 cursor-pointer transition-colors hover:bg-accent/40 ${active ? 'ring-2 ring-emerald-500/50' : ''}`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${c.dot}`} />
          <span className="font-medium text-sm">{agent.name}</span>
        </div>
        <Badge variant="outline" className={`${c.text} ${c.border} font-mono text-[10px] px-1.5 py-0`}>
          {agent.alive ? agent.state ?? 'unknown' : 'down'}
        </Badge>
      </div>

      <div className="space-y-1.5 text-xs font-mono text-muted-foreground">
        <div className="flex items-center justify-between">
          <span>ctx</span>
          <span className="text-foreground">
            {fmtBytes(agent.contextTokens)}{' '}
            <span className="text-muted-foreground/60">({pct.toFixed(0)}%)</span>
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded bg-zinc-800">
          <div
            className={`h-full transition-all ${pct >= 80 ? 'bg-rose-500' : pct >= 50 ? 'bg-amber-400' : 'bg-emerald-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-center justify-between">
          <span>pid</span>
          <span className="text-foreground">{agent.pid ?? '-'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>last</span>
          <span className="text-foreground">{relTime(agent.lastActivity)}</span>
        </div>
      </div>
    </Card>
  );
}
