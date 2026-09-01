'use client';

// Settings → Recycle bin. Everything on this machine that is deleted but not yet
// gone, in one place, with the clock that will finish the job.
//
// It is a page and not a card because of what it holds: this is the only screen in
// the product where things are queued for a delete nobody will ask about again. A
// countdown is worth nothing if you have to go looking for it, and until now the
// session bin was a text link at the bottom of a card on the System page.
//
// Two bins, because the product has two, and a page called "Recycle bin" that shows
// half of the deleted things is a trap:
//
//   - sessions — soft-deleted rows, purged by the gateway after `trashRetainDays`
//     (chat.listTrashed / restoreSession / purgeNow);
//   - agents — directory moved to `.hermit-trash`, purged only when you say so
//     (agents.listTrashed / requestRestore / requestPurge).
//
// They differ in the one way that matters and the page says so: a session leaves on
// a timer, an agent waits for a human. The agent bin stays in the sidebar too — that
// is a shortcut, not a second implementation; both read the same query.

import { useEffect, useState } from 'react';
import { Trash2, RotateCcw, Check, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { relTime } from '@/lib/format';
import { REASON_LABEL, fmtSize } from '@/lib/cleanup-labels';

// Days/hours left before the purge tick takes it. Already due reads "due now"
// rather than "-3d left": the tick runs every 10 minutes, so that is the truth.
function fmtDue(trashedAt: Date | string | null | undefined, retainDays: number): string {
  if (!trashedAt) return '';
  const ms = (typeof trashedAt === 'string' ? Date.parse(trashedAt) : trashedAt.getTime()) + retainDays * 86_400_000 - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'due now';
  const d = ms / 86_400_000;
  return d < 1 ? `${Math.max(1, Math.round(ms / 3.6e6))}h left` : `${Math.round(d)}d left`;
}

export function RecycleBinView() {
  const confirm = useConfirm();
  const utils = trpc.useUtils();

  const cfg = trpc.chat.cleanupConfig.useQuery().data;
  const trash = trpc.chat.listTrashed.useQuery(undefined, { refetchInterval: 60_000 }).data;
  const agents = trpc.agents.listTrashed.useQuery(undefined, { refetchInterval: 60_000 }).data ?? [];

  const invalidate = () => {
    void utils.chat.listTrashed.invalidate();
    void utils.chat.cleanupPreview.invalidate();
    void utils.chat.listSessions.invalidate();
  };
  const restore = trpc.chat.restoreSession.useMutation({ onSuccess: invalidate });
  const purgeNow = trpc.chat.purgeNow.useMutation({ onSuccess: invalidate });
  const setConfig = trpc.chat.setCleanupConfig.useMutation({ onSuccess: () => void utils.chat.cleanupConfig.invalidate() });

  const refreshAgents = () => {
    void utils.agents.list.invalidate();
    void utils.agents.listTrashed.invalidate();
    void utils.agents.pendingRequests.invalidate();
  };
  const restoreAgent = trpc.agents.requestRestore.useMutation({ onSuccess: refreshAgents });
  const purgeAgent = trpc.agents.requestPurge.useMutation({ onSuccess: refreshAgents });

  const rows = trash?.rows ?? [];
  const retainDays = trash?.retainDays ?? cfg?.trashRetainDays ?? 14;

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <p className="mb-4 text-xs text-muted-foreground">
        Deleted, but not yet gone — on the{' '}
        <span className="font-medium text-foreground/80">currently selected machine</span>. Restoring puts something
        back exactly as it was; the bin is the only place in the dashboard where anything is actually removed.
      </p>

      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">Sessions</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {rows.length} session{rows.length === 1 ? '' : 's'}
            {(trash?.uploadBytesTotal ?? 0) > 0 ? ` · ${fmtSize(trash?.uploadBytesTotal ?? 0)} of uploads` : ''}
          </span>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <span>Deleted permanently after</span>
          <input
            type="number"
            min={1}
            max={365}
            key={cfg?.trashRetainDays ?? 14}
            defaultValue={cfg?.trashRetainDays ?? 14}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 1 && v <= 365 && v !== cfg?.trashRetainDays) setConfig.mutate({ trashRetainDays: v });
            }}
            className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-right text-foreground tabular-nums"
          />
          <span>days in here — the conversation, its messages, its transcript and the files it uploaded.</span>
        </div>

        <div className="space-y-0.5">
          {rows.length === 0 && <p className="py-2 text-xs text-muted-foreground">No sessions in the bin.</p>}
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2 rounded-md px-1 py-1.5 text-xs hover:bg-muted/40 transition-colors">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{r.agentName}</span>
                <span className="text-muted-foreground"> · {r.title || r.preview || 'untitled'}</span>
              </span>
              <span className="hidden shrink-0 text-muted-foreground/70 sm:inline">{REASON_LABEL[r.trashReason ?? ''] ?? r.trashReason}</span>
              {r.uploadBytes > 0 && (
                <span className="hidden w-16 shrink-0 text-right tabular-nums text-muted-foreground/70 sm:inline">{fmtSize(r.uploadBytes)}</span>
              )}
              <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground" title={`binned ${relTime(r.trashedAt)}`}>
                {fmtDue(r.trashedAt, retainDays)}
              </span>
              <button
                type="button"
                title="Restore"
                aria-label={`restore ${r.title || r.id}`}
                onClick={() => restore.mutate({ id: r.id })}
                className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="Delete now — irreversible"
                aria-label={`delete ${r.title || r.id} permanently`}
                onClick={async () => {
                  if (await confirm({
                    title: 'Delete permanently?',
                    message: 'The conversation, its messages, its transcript and any files it uploaded are gone. This cannot be undone.',
                    confirmLabel: 'Delete',
                    danger: true,
                  })) purgeNow.mutate({ id: r.id });
                }}
                className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-rose-500 transition-colors cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </Card>

      <Card className="mt-4 p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">Agents</span>
          <span className="text-xs tabular-nums text-muted-foreground">{agents.length}</span>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Their working directory was moved to <code className="font-mono text-[11px]">.hermit-trash</code>, not deleted.
          Nothing here is on a timer — an agent leaves only when you say so.
        </p>
        <div className="space-y-0.5">
          {agents.length === 0 && <p className="py-2 text-xs text-muted-foreground">No agents in the bin.</p>}
          {agents.map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded-md px-1 py-1.5 text-xs hover:bg-muted/40 transition-colors">
              <span className="min-w-0 flex-1 truncate font-mono line-through decoration-muted-foreground/40">{a.name}</span>
              <span className="hidden min-w-0 shrink truncate text-muted-foreground/70 sm:inline">{a.directory}</span>
              <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">{relTime(a.trashedAt)}</span>
              <button
                type="button"
                title={`restore ${a.name}`}
                aria-label={`restore ${a.name}`}
                onClick={() => restoreAgent.mutate({ name: a.name })}
                disabled={restoreAgent.isPending}
                className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground transition-colors cursor-pointer disabled:opacity-40"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <PurgeAgentButton name={a.name} onConfirm={() => purgeAgent.mutate({ name: a.name })} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// Two-step permanent delete, same shape as the sidebar's: first click arms, second
// confirms, auto-disarms after 3.5s. Cancel sits FIRST — the armed pill grows
// leftwards, so a confirm placed last lands under the finger that just tapped
// (2026-08, `bug_confirm_button_cancel_under_finger`).
function PurgeAgentButton({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed) {
    return (
      <span className="shrink-0 inline-flex items-center gap-0.5 animate-in fade-in-0 duration-100">
        <button
          type="button"
          onClick={() => setArmed(false)}
          aria-label="cancel"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => { setArmed(false); onConfirm(); }}
          aria-label={`permanently delete ${name}`}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-rose-600 hover:bg-rose-500/10 cursor-pointer"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`permanently delete ${name}`}
      aria-label={`permanently delete ${name}`}
      onClick={() => setArmed(true)}
      className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-rose-500/10 hover:text-rose-600 transition-colors cursor-pointer"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}
