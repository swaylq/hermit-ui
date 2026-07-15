'use client';

// The empty-state starter screen for a chat with no messages yet: the agent's
// initials, a heading, and a few starter-prompt suggestions that fill the
// composer. Extracted verbatim from chat/page.tsx (P2-3); behaviour identical.
// Consumed by SessionPane.

import { useMemo } from 'react';

export function EmptyChat({ agentName, onPickPrompt }: { agentName?: string; onPickPrompt: (s: string) => void }) {
  const initials = (agentName ?? '?').slice(0, 2).toUpperCase();
  const suggestions = useMemo(
    () => [
      { title: 'Say hi', body: `say hi to ${agentName ?? 'them'}` },
      { title: 'Check in', body: 'what are you working on right now?' },
      { title: 'Triage failures', body: 'anything broken? show me recent failures from your daily log' },
      { title: 'Reflect', body: 'what did you learn this week? any patterns worth saving to evolution.md?' },
    ],
    [agentName],
  );
  return (
    <div className="flex min-h-[calc(100dvh-12rem)] flex-col items-center justify-center px-4 py-16 text-center">
      <div
        className="h-16 w-16 rounded-2xl bg-foreground text-background flex items-center justify-center font-mono text-base font-medium shadow-sm"
        aria-hidden="true"
      >
        {initials}
      </div>
      <h3 className="mt-5 text-lg font-medium tracking-tight text-foreground">
        Start a chat with <span className="font-mono">{agentName ?? '?'}</span>
      </h3>
      <p className="mt-1.5 text-xs text-muted-foreground">pick a starter, or just type below</p>
      <div className="w-full max-w-xl mt-7 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {suggestions.map((s, i) => (
          <button
            type="button"
            key={i}
            onClick={() => onPickPrompt(s.body)}
            className="group h-full text-left rounded-xl border border-border bg-background px-3.5 py-3 hover:border-foreground/30 hover:bg-accent/40 transition-colors cursor-pointer"
          >
            <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground/80 group-hover:text-foreground/80 transition-colors">
              {s.title}
            </div>
            <div className="mt-1 text-sm text-foreground/85 line-clamp-2">{s.body}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
