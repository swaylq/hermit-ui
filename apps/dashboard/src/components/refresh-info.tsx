'use client';

import { Badge } from '@/components/ui/badge';

// Hard-coded mirror of the polling intervals used in page.tsx + snapshot TTL.
// Kept in one place so the disclosure stays honest if intervals change.
export const REFRESH_INFO = [
  { label: 'agents', everyMs: 5000 },
  { label: 'usage', everyMs: 30_000 },
  { label: 'detail (open agent)', everyMs: 5000 },
  { label: 'snapshot cache', everyMs: 5000 },
];

export function RefreshInfo() {
  return (
    <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground font-mono">
      {REFRESH_INFO.map((r) => (
        <Badge key={r.label} variant="outline" className="font-mono text-[10px] px-1.5 py-0">
          {r.label} {Math.round(r.everyMs / 1000)}s
        </Badge>
      ))}
    </div>
  );
}
