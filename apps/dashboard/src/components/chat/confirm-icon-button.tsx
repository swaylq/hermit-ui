'use client';

import { useState, useEffect } from 'react';
import { Check, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// Icon button with an inline two-step confirm (click → ✓ confirm / ✗ cancel),
// auto-disarming after a few seconds. Used for destructive/disruptive session
// actions (restart, delete) per "删除/restart 前都需要确认".
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
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);

  if (armed) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background px-0.5">
        <button
          type="button"
          onClick={() => { setArmed(false); onConfirm(); }}
          className={cn(
            'inline-flex items-center gap-1 h-7 px-1.5 rounded text-xs font-medium cursor-pointer transition-colors',
            danger ? 'text-rose-600 hover:bg-rose-500/10' : 'text-foreground hover:bg-accent',
          )}
        >
          <Check className="h-3.5 w-3.5" /> confirm
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          title="cancel"
          aria-label="cancel"
          className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:bg-accent cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
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
