'use client';

// Which backend runs a session. Cards rather than a dropdown: every choice
// stays visible with its one-line description, which is what makes the choice
// informed instead of a guess at what "pi" or "omp" means. It also keeps the
// picker out of a portal, which matters in the detail sheet — base-ui overlays
// inside an overlay have bitten this app before (see docs, and the lightbox's
// bare-createPortal workaround).
//
// Driven by BACKEND_OPTIONS, so a new card appears here by adding it there.
// That list is not RUNTIME_KINDS: `triage` is a pi session whose mode picks
// itself, so it is a card without being a backend (see runtime-labels.ts).
//
// Shared by the new-chat screen and the session detail sheet so the two can't
// drift apart on labels or option set.

import { cn } from '@/lib/utils';
import { BACKEND_OPTIONS, BACKEND_BLURB, backendLabel, type BackendOption } from '@/lib/runtime-labels';

export function BackendPicker({
  value,
  onChange,
  disabled,
  agentDefault,
}: {
  value: BackendOption;
  onChange: (v: BackendOption) => void;
  disabled?: boolean;
  /** Marked in the list so "what this agent normally uses" stays visible. */
  agentDefault?: string | null;
}) {
  return (
    // Side by side once there is room; stacked on a phone, where two columns
    // wrap each blurb to five lines and the cards stop being scannable.
    <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2" role="radiogroup" aria-label="backend">
      {BACKEND_OPTIONS.map((kind, i) => {
        const active = value === kind;
        // An odd option count leaves the last card alone on its row at half
        // width, which reads as a rendering fault rather than a choice. Let it
        // span instead. Computed, not hard-coded to index 2, so adding a fourth
        // card goes back to a clean 2x2 on its own.
        const spansRow = BACKEND_OPTIONS.length % 2 === 1 && i === BACKEND_OPTIONS.length - 1;
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
              spansRow && 'min-[420px]:col-span-2',
              disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              active
                ? 'border-foreground/40 bg-accent'
                : 'border-border bg-card hover:border-foreground/25 hover:bg-accent/40',
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-foreground">{backendLabel(kind)}</span>
              {agentDefault === kind && (
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground">default</span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{BACKEND_BLURB[kind]}</p>
          </button>
        );
      })}
    </div>
  );
}
