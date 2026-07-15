'use client';

// Blocking-interaction cards for the chat timeline: InteractionCard (permission
// prompt or question, rendered inline from a {type:'interaction'} content block)
// and its QuestionCard child (option buttons + free-text "Other"). Extracted
// verbatim from chat/page.tsx (P2-3); behaviour identical. Consumed by the group
// renderer back in that file.

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { oneLineArg } from './tool-chips';

// A blocking interaction the agent's turn is waiting on — rendered inline from
// a {type:'interaction'} content block. Permission → Allow/Deny; question →
// option buttons (+ free-text "Other"). Clicking calls interaction.resolve,
// which flips the row's status (unblocking the gateway hook / mcp ask tool) and
// rewrites this block to its resolved state on the next SSE refetch.
export function InteractionCard({ block }: { block: any }) {
  const utils = trpc.useUtils();
  // The card always lives in the open session's timeline — scope the refetch to
  // THIS session instead of invalidating every cached session's message window.
  // (interaction.resolve also rewrites the row, which the SSE stream re-pushes,
  // so this invalidate is belt-and-braces.)
  const activeSessionId = useSearchParams().get('session');
  const resolve = trpc.interaction.resolve.useMutation({
    onSuccess: () => {
      utils.chat.listMessages.invalidate(activeSessionId ? { sessionId: activeSessionId } : undefined);
    },
  });
  const kind: string = block?.kind ?? 'question';
  const payload = block?.payload ?? {};
  const status: string = block?.status ?? 'pending';
  const decision = block?.decision ?? null;
  const id: string = block?.interactionId ?? '';
  const resolved = status !== 'pending';
  const busy = resolve.isPending;

  if (resolved) {
    let summary = '—';
    if (kind === 'permission') {
      summary = decision?.behavior === 'allow' ? '✓ allowed' : '✕ denied';
    } else {
      const ans = Array.isArray(decision?.answers) ? decision.answers : [];
      summary = ans.length ? `✓ ${ans.join(', ')}` : 'dismissed';
    }
    return (
      <div className="rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/70">{kind === 'permission' ? 'Permission' : 'Asked'}</span>
        {' · '}
        {summary}
      </div>
    );
  }

  if (kind === 'permission') {
    const tool = payload?.tool ?? 'tool';
    const argPreview = oneLineArg(payload?.input ?? {});
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
        <div className="text-xs font-medium text-amber-700 dark:text-amber-400">🔐 Permission needed</div>
        <div className="mt-1.5 font-mono text-[12px] text-foreground break-all">
          {tool}
          {argPreview ? <span className="text-muted-foreground"> {argPreview}</span> : null}
        </div>
        {payload?.input && Object.keys(payload.input).length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">details</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 px-2 py-1 text-[11px] text-foreground/80">
              {JSON.stringify(payload.input, null, 2)}
            </pre>
          </details>
        )}
        <div className="mt-2.5 flex gap-2">
          <Button size="sm" disabled={busy || !id} className="h-8"
            onClick={() => resolve.mutate({ id, decision: { behavior: 'allow' } })}>
            Allow
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !id} className="h-8"
            onClick={() => resolve.mutate({ id, decision: { behavior: 'deny' } })}>
            Deny
          </Button>
        </div>
      </div>
    );
  }

  // question
  const question: string = payload?.question ?? '';
  const options: Array<{ label: string; description?: string }> = Array.isArray(payload?.options) ? payload.options : [];
  const multiSelect = !!payload?.multiSelect;
  return (
    <QuestionCard
      question={question}
      options={options}
      multiSelect={multiSelect}
      busy={busy || !id}
      onResolve={(answers) => id && resolve.mutate({ id, decision: { answers } })}
    />
  );
}

function QuestionCard({ question, options, multiSelect, busy, onResolve }: {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  busy: boolean;
  onResolve: (answers: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const toggle = (label: string) => {
    if (!multiSelect) { onResolve([label]); return; }
    setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  };
  const submitMulti = () => {
    const answers = [...picked];
    if (custom.trim()) answers.push(custom.trim());
    if (answers.length) onResolve(answers);
  };
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
      <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
        ❓ {multiSelect ? 'Choose (one or more)' : 'Choose'}
      </div>
      {question && <div className="mt-1 whitespace-pre-wrap text-sm text-foreground">{question}</div>}
      <div className="mt-2 flex flex-col gap-1.5">
        {options.map((o, i) => {
          const active = picked.includes(o.label);
          return (
            <button
              key={i}
              type="button"
              disabled={busy}
              onClick={() => toggle(o.label)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-50',
                active ? 'border-foreground bg-accent' : 'border-border hover:border-foreground/40 hover:bg-accent/40',
              )}
            >
              <span className="text-foreground">
                {multiSelect ? (active ? '☑ ' : '☐ ') : ''}
                {o.label}
              </span>
              {o.description && <span className="mt-0.5 block text-xs text-muted-foreground">{o.description}</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Other…"
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !multiSelect && custom.trim()) { e.preventDefault(); onResolve([custom.trim()]); }
          }}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground/40 disabled:opacity-50"
        />
        {multiSelect ? (
          <Button size="sm" disabled={busy || (picked.length === 0 && !custom.trim())} className="h-8 shrink-0" onClick={submitMulti}>
            Submit
          </Button>
        ) : custom.trim() ? (
          <Button size="sm" disabled={busy} className="h-8 shrink-0" onClick={() => onResolve([custom.trim()])}>
            Send
          </Button>
        ) : null}
      </div>
    </div>
  );
}
