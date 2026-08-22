'use client';

// Which backend runs a session. Cards rather than a dropdown: every choice
// stays visible with its one-line description, which is what makes the choice
// informed instead of a guess at what "pi" or "prime" means. It also keeps the
// picker out of a portal, which matters in the detail sheet — base-ui overlays
// inside an overlay have bitten this app before.
//
// The list is the machine's own: two built-in backends (Claude Code and Codex,
// each on its own subscription) plus whatever the user composed under Settings
// → Backends. A machine that has composed none offers exactly two cards, which
// is the intended resting state rather than a misconfiguration.
//
// The queries live HERE rather than in each of the three callers: they all want
// the same answer, react-query dedupes them to one request each, and a caller
// that forgot to pass them would silently show a backend the machine has
// switched off.
//
// Shared by the new-chat screen, the agent detail sheet and the session detail
// sheet so the three can't drift apart on labels or option set.

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { availableBackends, isBackendEnabled, type Backend } from '@/lib/backends';
import { trpc } from '@/lib/trpc';

export function BackendPicker({
  value,
  onChange,
  disabled,
  agentDefault,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Marked in the list so "what this agent normally uses" stays visible. */
  agentDefault?: string | null;
}) {
  // Changed from a settings page the user is not looking at right now; stale
  // for a minute is fine, refetching on every sheet open is not.
  const cfg = trpc.machines.getBackendsConfig.useQuery(undefined, { staleTime: 60_000 });
  const creds = trpc.machines.getModelCredentials.useQuery(undefined, { staleTime: 60_000 });
  const options = availableBackends(cfg.data, value);
  const credLabel = (b: Backend) =>
    b.credentialId ? creds.data?.find((c) => c.id === b.credentialId)?.label ?? b.credentialId : null;

  return (
    <div className="space-y-2">
      {/* Side by side once there is room; stacked on a phone, where two columns
          wrap each blurb to five lines and the cards stop being scannable. */}
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2" role="radiogroup" aria-label="backend">
        {options.map((b, i) => {
          const active = value === b.id;
          // A disabled backend is still rendered when the session is ON it —
          // otherwise the picker would draw a different card as selected and lie
          // about what is running. Marked and unclickable instead.
          const retired = !isBackendEnabled(b.id, cfg.data);
          // An odd option count leaves the last card alone on its row at half
          // width, which reads as a rendering fault rather than a choice. Let it
          // span instead.
          const spansRow = options.length % 2 === 1 && i === options.length - 1;
          const credential = credLabel(b);
          return (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled || retired}
              onClick={() => onChange(b.id)}
              className={cn(
                'rounded-lg border px-3 py-2.5 text-left transition-colors',
                spansRow && 'min-[420px]:col-span-2',
                disabled || retired ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                active
                  ? 'border-foreground/40 bg-accent'
                  : 'border-border bg-card hover:border-foreground/25 hover:bg-accent/40',
              )}
            >
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-sm font-medium text-foreground">{b.label}</span>
                {b.builtIn && (
                  <span className="text-[9px] uppercase tracking-wide text-muted-foreground">subscription</span>
                )}
                {agentDefault === b.id && (
                  <span className="text-[9px] uppercase tracking-wide text-muted-foreground">default</span>
                )}
                {retired && (
                  <span className="text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-400">off</span>
                )}
              </div>
              {credential && (
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/80 truncate">{credential}</p>
              )}
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{b.blurb}</p>
            </button>
          );
        })}
      </div>
      {/* The two built-ins are the whole list until someone composes one. Say so
          once, with the way out — otherwise a machine that has never been to the
          Backends page reads as one where pi and prime are unavailable. */}
      {options.every((b) => b.builtIn) && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Only the subscription backends are set up here. Pair a harness with a credential under{' '}
          <Link href="/backends" className="underline hover:text-foreground">Settings → Backends</Link>{' '}
          to add pi, Prime Agent or DeepSeek.
        </p>
      )}
    </div>
  );
}
