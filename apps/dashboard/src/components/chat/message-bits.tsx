'use client';

// Small presentational message-timeline bits. Extracted verbatim from
// chat/page.tsx (P2-3); behaviour identical. StreamingDots is consumed by
// MessageRow and by TypingIndicator (here); TypingIndicator by SessionPane.

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/markdown';

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

// Typewriter reveal for the streaming tail's assistant text. The server sends
// whole content blocks (no token deltas — see the SSE route), so the "typing"
// is synthesized client-side: reveal plain text char-by-char (cheap, no
// markdown re-parse mid-type), then settle into rendered Markdown once the
// block is fully shown. Honors prefers-reduced-motion.
function useTypewriter(text: string, enabled: boolean): number {
  const [shown, setShown] = useState(enabled ? 0 : text.length);
  useEffect(() => {
    if (!enabled) { setShown(text.length); return; }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      setShown(text.length);
      return;
    }
    let raf = 0;
    let last = 0;
    const step = (now: number) => {
      if (now - last >= 28) {
        last = now;
        // ease-out: reveal a chunk proportional to what's left (≈0.85s to full,
        // regardless of length), so short blocks finish fast and long ones glide.
        setShown((cur) => (cur >= text.length ? cur : Math.min(text.length, cur + Math.max(2, Math.round((text.length - cur) * 0.14)))));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, enabled]);
  return Math.min(shown, text.length);
}

export function TypedText({ text, typing }: { text: string; typing: boolean }) {
  const shown = useTypewriter(text, typing);
  if (shown >= text.length) return <Markdown>{text}</Markdown>;
  return <span className="whitespace-pre-wrap break-words">{text.slice(0, shown)}</span>;
}
