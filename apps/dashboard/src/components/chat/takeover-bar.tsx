'use client';

// The banner shown while the Brain is driving a conversation, and the button that
// hands it over. See docs/brain-takeover-design.md.
//
// The banner exists for one reason: the Brain infers the goal from the conversation
// rather than being told it, so a wrong reading is the main failure mode. Putting
// that reading in front of the human, above the composer, turns a wrong one into a
// two-second correction instead of something they discover afterwards.

import { Bot, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export function TakeoverBar({
  goal,
  turns,
  turnCap,
  onRelease,
  releasing,
}: {
  goal: string | null;
  turns: number;
  turnCap: number;
  onRelease: () => void;
  releasing: boolean;
}) {
  return (
    // pr-16 keeps the Release button clear of the floating button dock, which is a
    // draggable z-40 layer that lives in the bottom-right by default. Two controls in
    // the same corner, one of them floating, is a collision you only see on a phone.
    <div className="shrink-0 border-t border-border bg-muted/50 py-2 pl-3 pr-16">
      <div className="flex items-start gap-2">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Brain is driving this conversation</span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
              {turns}/{turnCap}
            </span>
          </div>
          {/* The inferred goal, verbatim. Deliberately not truncated to one line —
              a goal you can't fully read is a goal you can't check. */}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {goal ? goal : <span className="italic">Reading the conversation…</span>}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground/70">
            Type anything to take it back.
          </p>
        </div>
        <button
          type="button"
          onClick={onRelease}
          disabled={releasing}
          className={cn(
            'shrink-0 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1',
            'text-[11px] transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-wait',
          )}
        >
          <X className="h-3 w-3" aria-hidden="true" />
          Release
        </button>
      </div>
    </div>
  );
}
