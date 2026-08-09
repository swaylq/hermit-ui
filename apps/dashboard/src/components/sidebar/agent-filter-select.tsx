'use client';

// The "All agents" dropdown above the chat recents list — split out of
// recent-lists.tsx so it can be lazy()'d there.
//
// Why it's worth a file of its own: recent-lists is imported by AppSidebar, which
// AuthGate mounts in the ROOT layout, so everything it pulls in lands in the shell
// chunk every route downloads before first paint. This one dropdown was the only
// `@base-ui/react/select` user in that graph, and base-ui's Select carries the
// combobox + floating-ui positioning engine with it — a six-figure byte count that
// /usage, /help, /skills, /notifications and friends were parsing for a control
// they never render. Behind React.lazy it becomes its own chunk, fetched only when
// the sessions list actually mounts with >1 agent.
//
// Props are plain data (no Select types leak out), so recent-lists keeps zero
// static reference to base-ui.

import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

export default function AgentFilterSelect({
  value,
  onChange,
  agentNames,
  countFor,
  total,
}: {
  value: string;
  onChange: (v: string) => void;
  agentNames: string[];
  countFor: (name: string) => number;
  total: number;
}) {
  return (
    // modal={false} so its backdrop can't lock the page — the default scroll-lock
    // left sidebar links unclickable after a cycle.
    <Select value={value} onValueChange={(v) => onChange(v ?? '')} modal={false}>
      <SelectTrigger
        aria-label="filter sessions by agent"
        className="w-auto shrink-0 border-sidebar-border bg-sidebar/60 font-mono text-sidebar-foreground/90 hover:border-sidebar-foreground/20 hover:bg-sidebar-accent/60 focus-visible:border-sidebar-foreground/40 focus-visible:ring-sidebar-foreground/15"
      >
        <SelectValue>{(v: string | null) => (v ? v : 'All agents')}</SelectValue>
      </SelectTrigger>
      <SelectContent className="font-mono">
        <SelectItem value="">
          All agents <span className="text-muted-foreground">· {total}</span>
        </SelectItem>
        {agentNames.map((n) => (
          <SelectItem key={n} value={n}>
            {n} <span className="text-muted-foreground">· {countFor(n)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
