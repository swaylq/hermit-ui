'use client';

// The agents "recycle bin": soft-deleted agents (their dir moved to
// .hermit-trash) with restore + a two-step purge. Extracted verbatim from
// app-sidebar.tsx (P2-4) into components/sidebar/ as a cohesive unit; behaviour
// identical. TrashedAgents is rendered by RecentAgents; PurgeButton is private.

import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { ChevronDown, Check, X, Trash2, RotateCcw } from 'lucide-react';

// Recycle bin pinned to the bottom of the agents sidebar: agents that were
// soft-deleted (their dir moved to .hermit-trash) but not yet purged. Collapsed
// by default; restore moves an agent back, purge is a two-step permanent delete.
export function TrashedAgents() {
  const trashed = trpc.agents.listTrashed.useQuery(undefined, { refetchInterval: 15_000 });
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const refresh = () => {
    void utils.agents.list.invalidate();
    void utils.agents.listTrashed.invalidate();
    void utils.agents.pendingRequests.invalidate();
  };
  const restore = trpc.agents.requestRestore.useMutation({ onSuccess: refresh });
  const purge = trpc.agents.requestPurge.useMutation({ onSuccess: refresh });
  const items = trashed.data ?? [];
  if (items.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-sidebar-border/60 pt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full px-3 py-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70 hover:text-muted-foreground cursor-pointer"
      >
        <Trash2 className="h-3 w-3" />
        <span>Recycle bin</span>
        <span className="tabular-nums text-muted-foreground/50">{items.length}</span>
        <ChevronDown className={cn('ml-auto h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="px-2 pb-2 space-y-px max-h-52 overflow-y-auto">
          {items.map((a) => (
            <li
              key={a.id}
              className="group flex items-center gap-1 rounded-lg px-2.5 py-1.5 hover:bg-sidebar-accent/40"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-mono text-sidebar-foreground/55 line-through decoration-muted-foreground/40">
                  {a.name}
                </div>
                {a.trashedAt && (
                  <div className="text-[10px] font-mono text-muted-foreground/50 tabular-nums">
                    deleted {relTime(a.trashedAt)}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => restore.mutate({ name: a.name })}
                disabled={restore.isPending}
                title={`restore ${a.name}`}
                aria-label={`restore ${a.name}`}
                className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:bg-sidebar-accent hover:text-emerald-600 transition-colors cursor-pointer disabled:opacity-40"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <PurgeButton name={a.name} onConfirm={() => purge.mutate({ name: a.name })} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Two-step permanent delete: first click arms, second confirms; auto-disarms
// after 3.5s. Mirrors the header ConfirmDeleteButton on the agents page.
function PurgeButton({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed) {
    return (
      <span className="shrink-0 inline-flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => { setArmed(false); onConfirm(); }}
          title={`permanently delete ${name}`}
          aria-label={`permanently delete ${name}`}
          className="inline-flex items-center justify-center h-6 w-6 rounded text-rose-600 hover:bg-rose-500/10 cursor-pointer"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          aria-label="cancel"
          className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:bg-sidebar-accent cursor-pointer"
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
      title={`permanently delete ${name}`}
      aria-label={`permanently delete ${name}`}
      className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 transition-colors cursor-pointer"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}
