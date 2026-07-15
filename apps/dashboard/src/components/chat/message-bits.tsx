'use client';

// Small presentational message-timeline bits. Extracted verbatim from
// chat/page.tsx (P2-3); behaviour identical. StreamingDots is consumed by
// MessageRow and by TypingIndicator (here); TypingIndicator by SessionPane.

import { cn } from '@/lib/utils';

// "Thinking" indicator — a single solid dot that gently breathes (scale +
// opacity), ChatGPT style. `variant` only nudges the size: a touch smaller
// when it sits inline at the tail of a tool-chip cluster.
export function StreamingDots({ variant, dot = 'bg-foreground' }: { variant: 'bubble' | 'chip'; dot?: string }) {
  return (
    <span
      aria-label="assistant is thinking"
      className={cn(
        'inline-block shrink-0 rounded-full align-middle motion-safe:animate-[breathe_1.4s_ease-in-out_infinite]',
        dot,
        variant === 'chip' ? 'h-2.5 w-2.5' : 'h-3 w-3',
      )}
    />
  );
}

export function TypingIndicator({ dot }: { dot: string }) {
  return (
    <div className="flex justify-start mt-2">
      <StreamingDots variant="bubble" dot={dot} />
    </div>
  );
}
