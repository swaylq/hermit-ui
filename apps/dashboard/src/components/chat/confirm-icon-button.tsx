'use client';

import { useRef, useState, useEffect } from 'react';
import { Check, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// How long the armed pill waits before it will accept a click.
//
// The tap that ARMS this button and the tap that confirms it land on the same
// pixels (see the ordering note below), so without a dead time a double-tap —
// or a double-click, or an impatient second tap while the pill is still
// animating in — would confirm a destructive action the user only pointed at
// once. 350ms is just past iOS's ~300ms double-tap window. A click inside it is
// ignored and the pill STAYS ARMED, so the user's next tap still works; nothing
// is silently swallowed.
const ARM_GUARD_MS = 350;

// How long the pill stays armed with no input. Long enough to read it on a
// phone, short enough that a stray confirm can't be collected minutes later.
const AUTO_DISARM_MS = 5_000;

// Icon button with an inline two-step confirm (click → ✗ cancel / ✓ confirm),
// auto-disarming after a few seconds. Used for destructive/disruptive session
// actions (restart, delete) per "删除/restart 前都需要确认".
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
}: {
  icon: LucideIcon;
  title: string;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const armedAt = useRef(0);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), AUTO_DISARM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  if (armed) {
    // Shared by both halves of the pill: a click that arrives inside the guard
    // window is the arming tap bouncing, not an answer — drop it and leave the
    // pill up.
    const settled = () => Date.now() - armedAt.current >= ARM_GUARD_MS;
    return (
      <span className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background px-0.5">
        <button
          type="button"
          onClick={() => { if (settled()) setArmed(false); }}
          title="cancel"
          aria-label="cancel"
          className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground transition-colors hover:bg-accent cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => { if (!settled()) return; setArmed(false); onConfirm(); }}
          title={`confirm — ${title}`}
          aria-label={`confirm — ${title}`}
          className={cn(
            'inline-flex items-center gap-1 h-7 px-1.5 rounded text-xs font-medium cursor-pointer transition-colors',
            danger ? 'text-rose-600 hover:bg-rose-500/10' : 'text-foreground hover:bg-accent',
          )}
        >
          <Check className="h-3.5 w-3.5" /> confirm
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => { armedAt.current = Date.now(); setArmed(true); }}
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
