'use client';

import { useState, useEffect } from 'react';
import { Check, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  AUTO_DISARM_MS, DISARMED, confirmStep, type ConfirmState,
} from './header-actions-core';

// The timings, the arm guard and the ordering rationale all live in
// `header-actions-core.ts` now — the iOS port runs that same state machine over
// the same table, so this file holds the pixels and nothing else.
//
// Icon button with an inline two-step confirm (click → ✗ cancel / ✓ confirm),
// auto-disarming after a few seconds. Used for destructive/disruptive session
// actions (restart, delete) per "删除/restart 前都需要确认".
//
// `confirmLabel` also makes it the header's "folded control": an action whose
// name is too long to sit in a 28px row all day, shown only once you have
// touched it. Same two steps, and the second one then says what it does
// ("pure chat") rather than "confirm" — which a destructive action does not
// need, because its icon already said.
//
// ORDER IS LOAD-BEARING: cancel first, confirm LAST.
//
// Every place this renders is right-anchored — the chat header's action cluster
// and the phone's overflow tray both sit against the right edge — so when the
// 28px icon is replaced by the ~105px pill, the pill grows LEFTWARD and its
// right edge stays exactly where the icon's was. Whichever child is last
// therefore covers the pixels the user just tapped.
//
// It used to be `confirm` then `cancel`, which put CANCEL under the finger:
// tapping the trash icon twice in the same spot armed it and then cancelled it,
// so delete looked broken ("点击删除了还在", 2026-08-30 — measured at both 390px
// and 1280px, all three header buttons). Second tap in the same place now means
// yes, which is what everyone tries first.
export function ConfirmIconButton({
  icon: Icon,
  title,
  onConfirm,
  disabled = false,
  busy = false,
  danger = false,
  confirmLabel,
}: {
  icon: LucideIcon;
  title: string;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
  /**
   * What the confirm half says, and — when given — it carries the button's own
   * icon instead of the generic ✓. Default "confirm", which is right for
   * "are you sure" on an action the icon already named.
   */
  confirmLabel?: string;
}) {
  const [confirm, setConfirm] = useState<ConfirmState>(DISARMED);
  const armed = confirm.armed;
  const armedAt = confirm.armed ? confirm.armedAt : 0;
  useEffect(() => {
    if (!armed) return;
    // Fires at the deadline, and the reducer re-checks the clock: a timer that
    // lands early (a suspended tab catching up) leaves the pill armed instead of
    // yanking it out from under a finger.
    const t = setTimeout(
      () => setConfirm((s) => confirmStep(s, 'timeout', Date.now()).state),
      AUTO_DISARM_MS,
    );
    return () => clearTimeout(t);
  }, [armed, armedAt]);

  if (confirm.armed) {
    // Both halves go through the same reducer: a click that arrives inside the
    // guard window is the arming tap bouncing, not an answer — it is dropped and
    // the pill stays up.
    const step = (event: 'cancel' | 'confirm') => {
      const out = confirmStep(confirm, event, Date.now());
      setConfirm(out.state);
      if (out.fire) onConfirm();
    };
    return (
      <span className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background px-0.5">
        <button
          type="button"
          onClick={() => step('cancel')}
          title="cancel"
          aria-label="cancel"
          className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground transition-colors hover:bg-accent cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => step('confirm')}
          title={`confirm — ${title}`}
          aria-label={`confirm — ${title}`}
          className={cn(
            // nowrap: a labelled confirm ("pure chat") wraps to two lines inside
            // the phone's overflow tray, which is narrower than the header row,
            // and a two-line pill is taller than every button beside it.
            'inline-flex items-center gap-1 h-7 px-1.5 rounded text-xs font-medium whitespace-nowrap cursor-pointer transition-colors',
            danger ? 'text-rose-600 hover:bg-rose-500/10' : 'text-foreground hover:bg-accent',
          )}
        >
          {confirmLabel ? (
            <>
              <Icon className={cn('h-3.5 w-3.5', danger ? undefined : 'text-amber-500')} /> {confirmLabel}
            </>
          ) : (
            <>
              <Check className="h-3.5 w-3.5" /> confirm
            </>
          )}
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirm(confirmStep(confirm, 'press', Date.now()).state)}
      disabled={disabled || busy}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
        danger ? 'hover:bg-rose-500/10 hover:text-rose-600' : 'hover:bg-accent hover:text-foreground',
      )}
    >
      {busy ? <span className="text-xs">…</span> : <Icon className="h-4 w-4" />}
    </button>
  );
}
