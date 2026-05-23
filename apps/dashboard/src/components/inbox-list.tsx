'use client';

import { Badge } from '@/components/ui/badge';
import { relTime } from '@/lib/format';

type Event = {
  id: string;
  agentName: string;
  type: string;
  title: string | null;
  message: string;
  ts: Date | string;
};

export function InboxList({ events }: { events: Event[] }) {
  if (!events.length) {
    return <p className="text-sm text-muted-foreground py-8 text-center">no events yet</p>;
  }
  return (
    <div className="space-y-2">
      {events.map((e) => (
        <div key={e.id} className="rounded border bg-card p-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-xs gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Badge variant="secondary" className="font-mono text-[10px] shrink-0">
                {e.agentName}
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px] shrink-0">
                {e.type}
              </Badge>
              {e.title && <span className="text-muted-foreground truncate">{e.title}</span>}
            </div>
            <span className="text-muted-foreground font-mono shrink-0">{relTime(e.ts)}</span>
          </div>
          <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/90 break-words">
            {e.message}
          </pre>
        </div>
      ))}
    </div>
  );
}
