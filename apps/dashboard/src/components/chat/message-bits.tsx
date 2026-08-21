'use client';

// Small presentational message-timeline bits. Extracted verbatim from
// chat/page.tsx (P2-3); behaviour identical. StreamingDots is consumed by
// MessageRow and by TypingIndicator (here); TypingIndicator by SessionPane.

import { useState, useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/markdown';
import {
  revealAdvance,
  settleSplit,
  closeOpenFence,
  markReveal,
  adoptReveal,
  TICK_MS,
  TAIL_MD_MAX,
} from '@/lib/stream-reveal';
import { isSameDay, ymdLocal } from './lib';

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

// Typewriter reveal for the streaming tail's assistant text.
//
// The pacing, the block split and the position memory all live in
// lib/stream-reveal.ts, where they can be tested against a simulated arrival
// trace; what is left here is the part that needs a component: a rAF loop, and
// the decision about when the reveal is allowed to run at all.
//
// Two things about that decision, both of them bugs this replaced:
//
//   · `typing` is decided per render from the row's age and from whether the
//     page still thinks it is growing — and both decay while a long reply is
//     still being written. So it may only START the reveal. Once started, the
//     latch keeps it running until it catches up, however long the reply takes.
//     Before this, a reply crossed the eight-second mark and the rest of it
//     dropped onto the screen in whatever lumps the pushes happened to carry.
//
//   · A mounting row asks `adoptReveal` where its predecessor got to. The
//     gateway retracts the placeholder row and lands the finished record in the
//     same push, so mid-reply the component is REPLACED, and starting from zero
//     meant the paragraph just watched arrive vanished and retyped itself.
//
// Honors prefers-reduced-motion (no animation at all).
function useTypewriter(text: string, typing: boolean, streamKey: string): number {
  const [shown, setShown] = useState(() => (typing ? adoptReveal(streamKey, text) : text.length));
  // Fractional: at 30fps a slow writer is worth less than a whole character per
  // frame, and rounding that down every frame would stop the reveal dead.
  const posRef = useRef(shown);
  const shownRef = useRef(shown);
  const textRef = useRef(text);
  const rafRef = useRef(0);
  const grewAtRef = useRef(0);
  const startedRef = useRef(typing);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  useEffect(() => {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (!grewAtRef.current || text.length > textRef.current.length) grewAtRef.current = now;
    textRef.current = text;
    if (typing) startedRef.current = true;

    const settle = (n: number) => {
      posRef.current = n;
      if (shownRef.current !== n) { shownRef.current = n; setShown(n); }
    };

    const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduced || !startedRef.current) { settle(text.length); return; }
    // Content that shrank (a re-sync rewriting a row) is not something to chase
    // backwards — the reveal simply finds itself at the end.
    if (posRef.current > text.length) posRef.current = text.length;
    markReveal(streamKey, text, Math.floor(posRef.current));
    if (posRef.current >= text.length) { settle(text.length); return; }
    if (rafRef.current) return; // a loop is already chasing textRef

    let last = 0;
    const frame = (t: number) => {
      const dt = last === 0 ? TICK_MS : t - last;
      if (dt < TICK_MS) { rafRef.current = requestAnimationFrame(frame); return; }
      last = t;
      const total = textRef.current.length;
      const pos = revealAdvance(Math.min(posRef.current, total), total, dt, t - grewAtRef.current);
      posRef.current = pos;
      const next = Math.floor(pos);
      if (next !== shownRef.current) { shownRef.current = next; setShown(next); }
      markReveal(streamKey, textRef.current, next);
      // Stop when caught up; the effect above restarts the loop the moment the
      // text grows again, so an idle tail costs nothing.
      rafRef.current = pos >= total ? 0 : requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [text, typing, streamKey]);

  return Math.min(shown, text.length);
}

export function TypedText({ text, typing, streamKey = '' }: { text: string; typing: boolean; streamKey?: string }) {
  const shown = useTypewriter(text, typing, streamKey);
  // One wrapper in both states: catching up must not change the shape of the
  // tree, or the markdown subtree remounts on the last frame of every reply.
  if (shown >= text.length) return <div><Markdown>{text}</Markdown></div>;
  // Rendered markdown all the way down, rather than raw source until it catches
  // up. The old version flipped the whole bubble between source and rendered
  // several times a second — asterisks blinking in and out, a table collapsing
  // and re-forming — and every flip was a height change the sticky-bottom
  // observer answered with a scroll. See settleSplit for why this costs the
  // same per frame whether the reply is one paragraph or thirty.
  const { settled, tail } = settleSplit(text.slice(0, shown));
  return (
    <div>
      {settled ? <Markdown>{settled}</Markdown> : null}
      {tail ? (
        tail.length <= TAIL_MD_MAX ? (
          <Markdown>{closeOpenFence(tail)}</Markdown>
        ) : (
          // The one block that can get this big without an internal line to
          // settle at is a long fenced code block, and it is also the one whose
          // re-parse cost climbs with length (highlight.js). Plain until it ends.
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-[1.65]">{tail}</div>
        )
      ) : null}
    </div>
  );
}

// A centered "Today / Yesterday / <date>" separator between message-timeline
// day groups. Consumed by MessageTimeline (in page.tsx).
export function DateDivider({ day }: { day: Date | string }) {
  const label = useMemo(() => {
    const x = typeof day === 'string' ? new Date(day) : day;
    const now = new Date();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (isSameDay(x, now)) return 'Today';
    if (isSameDay(x, yesterday)) return 'Yesterday';
    return ymdLocal(x);
  }, [day]);
  return (
    <div className="flex justify-center my-5">
      <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-muted-foreground/60 px-2">
        {label}
      </span>
    </div>
  );
}
