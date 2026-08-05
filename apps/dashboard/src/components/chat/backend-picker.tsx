'use client';

// Which backend runs a session. Two mutually exclusive options, so a segmented
// control rather than a dropdown: both choices stay visible with their one-line
// description, which is what makes the choice informed instead of a guess at
// what "pi" means. It also keeps the picker out of a portal, which matters in
// the detail sheet — base-ui overlays inside an overlay have bitten this app
// before (see docs, and the lightbox's bare-createPortal workaround).
//
// Shared by the new-chat screen and the session detail sheet so the two can't
// drift apart on labels or option set.

import { cn } from '@/lib/utils';
import { RUNTIME_KINDS, RUNTIME_BLURB, runtimeLabel, type RuntimeKind } from '@/lib/runtime-labels';

export function BackendPicker({
  value,
  onChange,
  disabled,
  agentDefault,
}: {
  value: RuntimeKind;
  onChange: (v: RuntimeKind) => void;
  disabled?: boolean;
  /** Marked in the list so "what this agent normally uses" stays visible. */
  agentDefault?: string | null;
}) {
  return (
    // Side by side once there is room; stacked on a phone, where two columns
    // wrap each blurb to five lines and the cards stop being scannable.
    <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2" role="radiogroup" aria-label="backend">
      {RUNTIME_KINDS.map((kind) => {
        const active = value === kind;
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(kind)}
            className={cn(
              'rounded-lg border px-3 py-2.5 text-left transition-colors',
              disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              active
                ? 'border-foreground/40 bg-accent'
                : 'border-border bg-card hover:border-foreground/25 hover:bg-accent/40',
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-foreground">{runtimeLabel(kind)}</span>
              {agentDefault === kind && (
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground">default</span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{RUNTIME_BLURB[kind]}</p>
          </button>
        );
      })}
    </div>
  );
}
