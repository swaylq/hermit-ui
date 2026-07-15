'use client';

// The docked bottom bar shown when a chat session is no longer active: a status
// line plus a "Restart to continue" button. Extracted verbatim from
// chat/page.tsx (P2-3); behaviour identical. Consumed by SessionPane.

import { Button } from '@/components/ui/button';

// Shown in place of the composer when the session's agent process is gone
// (gateway reports !alive, but it ran before). Typing would just queue a
// message the dead pane can't pick up, so we require an explicit restart —
// which kills any stale pane; the next message respawns claude via --resume
// with history preserved.
export function RestartBar({ restarting, onRestart }: { restarting: boolean; onRestart: () => void }) {
  return (
    <div className="shrink-0 bg-background pwa-safe-b">
      <div className="mx-auto w-full max-w-3xl px-3 pb-3 pt-1">
        <div className="flex items-center justify-between gap-3 rounded-[26px] border border-border bg-muted/40 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400" aria-hidden="true" />
            <span className="truncate">This session isn&apos;t active.</span>
          </div>
          <Button size="sm" onClick={onRestart} disabled={restarting} className="shrink-0">
            {restarting ? 'restarting…' : 'Restart to continue'}
          </Button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/50">
          restart respawns the agent with history preserved (claude --resume)
        </p>
      </div>
    </div>
  );
}
