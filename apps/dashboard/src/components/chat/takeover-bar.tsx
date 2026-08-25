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
  agentName,
  agentWorking,
  brainWorking,
  drafting,
  onRelease,
  releasing,
}: {
  goal: string | null;
  turns: number;
  agentName: string;
  /** The agent is mid-turn — the Brain is waiting on it. */
  agentWorking: boolean;
  /** The Brain is mid-turn — reading the reply and deciding what to do. */
  brainWorking: boolean;
  /** The Brain is composing a message (its text is ghosted in the composer). */
  drafting: boolean;
  onRelease: () => void;
  releasing: boolean;
}) {
  // The gap this closes: between an agent finishing and the Brain's next move there
  // is up to a minute of reading and deciding. Without a word for it the banner reads
  // "Brain is driving" while nothing visibly happens, and a working feature looks
  // stalled. Name whichever thing is actually happening.
  const activity = drafting
    ? { text: 'Brain is writing a reply…', busy: true }
    : brainWorking
      ? { text: 'Brain is reading the reply and deciding…', busy: true }
      : agentWorking
        ? { text: `Waiting for ${agentName}…`, busy: true }
        : { text: 'Waiting for the next step…', busy: false };
  return (
    // Same container as ComposeBar and ScheduleBar (mx-auto w-full max-w-3xl px-3), so
    // this lines up with the composer box and the suggestion chips instead of running
    // edge-to-edge under a centred column. mt-2 because ScheduleBar only pads its top —
    // without it the banner's border sits flush against the chips.
    //
    // No dodge for the floating mic any more: the dock is clamped above this whole
    // control stack, so it can't reach the Release button (or the chips above it).
    <div className="mx-auto mt-2 w-full max-w-3xl shrink-0 px-3">
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/50 px-3 py-2">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Brain is driving this conversation</span>
            {/* A running count, not a budget — there's no ceiling to show it against.
                Kept because "how many turns has it taken" is worth knowing at a glance
                when you're deciding whether to let it keep going. */}
            {turns > 0 && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {turns} turn{turns === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {/* The inferred goal, verbatim. Deliberately not truncated to one line —
              a goal you can't fully read is a goal you can't check. */}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {goal ? goal : <span className="italic">Reading the conversation…</span>}
          </p>
          {/* Inline text, not a flex row: as three flex children these wrapped into
              two ragged columns on a phone with the separator orphaned between them.
              It reads as one sentence, so it should wrap as one. */}
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
            {activity.busy && (
              <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500 align-middle" />
            )}
            {activity.text}
            <span className="mx-1 text-muted-foreground/40">·</span>
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
