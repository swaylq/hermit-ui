'use client';

// Session cleanup — Settings → System, directly under Host health, because they
// are the same account read at two depths: Host health is what the sessions are
// COSTING right now, this is how many of them there still are.
//
// The one design rule the UI has to carry (docs/session-cleanup-design.md): the
// reversible tiers run on the click, the irreversible one asks first. So the
// button is honest about doing something immediately, and the dialog it opens is
// only ever about the recycle bin.

import { useState } from 'react';
import { Archive, Trash2, RotateCcw, ShieldCheck, Brush } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogPortal, DialogOverlay } from '@/components/ui/dialog';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { useConfirm } from '@/components/ui/confirm-dialog';

function fmtIdle(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 30) return `${Math.round(days)}d`;
  return `${Math.round(days / 30)}mo`;
}

function fmtAgo(d: Date | string | null | undefined): string {
  if (!d) return 'never';
  const ms = Date.now() - (typeof d === 'string' ? Date.parse(d) : d.getTime());
  if (!Number.isFinite(ms) || ms < 0) return 'never';
  const h = ms / 3.6e6;
  if (h < 1) return `${Math.max(1, Math.round(ms / 6e4))}m ago`;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

type Verdict = {
  id: string;
  agentName: string;
  title: string | null;
  preview: string | null;
  idleDays: number;
  contextTokens: number | null;
  reason: string;
  blockedBy: string | null;
};

// Mirrors server/session-cleanup.ts. Duplicated rather than imported so a client
// bundle never pulls in the prisma-importing module.
const REASON_LABEL: Record<string, string> = {
  'dispatch-done': 'finished dispatch — its result was already reported back',
  stillborn: 'never got a reply — a failed spawn, not a conversation',
  empty: 'no messages at all',
  'agent-trashed': 'its agent is in the trash',
  idle: 'archived and untouched since',
  manual: 'cleaned by hand',
  blocked: 'something still points at it',
};

const BLOCKER_LABEL: Record<string, string> = {
  cron: 'a cron reports into it',
  unread: 'its last message is unread',
  interaction: 'waiting on an answer from you',
  queued: 'has an undelivered message',
  unanswered: 'flagged: you asked, nobody answered',
  working: 'working right now',
  dispatch: 'wired to a Brain dispatch or takeover',
  grouped: 'filed in a group',
  named: 'you gave it a name',
  kept: 'you marked it Keep',
};

function SessionLine({ v }: { v: Verdict }) {
  return (
    <span className="min-w-0 flex-1 truncate">
      <span className="font-medium">{v.agentName}</span>
      <span className="text-muted-foreground"> · {v.title || v.preview || 'untitled'}</span>
    </span>
  );
}

export function SessionCleanupView() {
  const [open, setOpen] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const confirm = useConfirm();
  const utils = trpc.useUtils();

  const cfg = trpc.chat.cleanupConfig.useQuery().data;
  const host = trpc.hosts.stat.useQuery(undefined, { refetchInterval: 60_000 }).data?.stat;
  const preview = trpc.chat.cleanupPreview.useQuery(undefined, { refetchInterval: 60_000 }).data;
  const trash = trpc.chat.listTrashed.useQuery(undefined, { enabled: showTrash }).data;

  const invalidate = () => {
    void utils.chat.cleanupPreview.invalidate();
    void utils.chat.cleanupConfig.invalidate();
    void utils.chat.listTrashed.invalidate();
    void utils.chat.listSessions.invalidate();
  };

  const apply = trpc.chat.cleanupApply.useMutation({ onSuccess: invalidate });
  const trashSessions = trpc.chat.trashSessions.useMutation({ onSuccess: invalidate });
  const restore = trpc.chat.restoreSession.useMutation({ onSuccess: invalidate });
  const keep = trpc.chat.keepSession.useMutation({ onSuccess: invalidate });
  const purgeNow = trpc.chat.purgeNow.useMutation({ onSuccess: invalidate });
  const setConfig = trpc.chat.setCleanupConfig.useMutation({ onSuccess: () => void utils.chat.cleanupConfig.invalidate() });

  // The click: do the reversible work, then open the review for the rest. Nothing
  // reaches the bin without the dialog below, so this button can never cost more
  // than a `reopen` on its own.
  async function runCleanup() {
    const r = await apply.mutateAsync({});
    setPicked(new Set((preview?.trash ?? []).map((v: Verdict) => v.id)));
    if ((preview?.trash?.length ?? 0) > 0) setOpen(true);
    else {
      await confirm({
        title: 'Cleanup done',
        message: `Archived ${r.archived}. Nothing looked disposable enough to propose for the bin.`,
        confirmLabel: 'OK',
      });
    }
  }

  async function confirmTrash() {
    const ids = [...picked];
    if (ids.length === 0) { setOpen(false); return; }
    await trashSessions.mutateAsync({ ids, reason: 'idle' });
    setOpen(false);
  }

  async function keepAll() {
    for (const v of preview?.trash ?? []) await keep.mutateAsync({ id: v.id, keep: true });
    setOpen(false);
  }

  const archiveN = preview?.archive.length ?? 0;
  const trashN = preview?.trash.length ?? 0;
  const sparedN = preview?.spared.length ?? 0;
  const busy = apply.isPending || trashSessions.isPending;

  return (
    <>
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">Session cleanup</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {preview?.total ?? '—'} sessions{(preview?.trashed ?? 0) > 0 ? ` · ${preview?.trashed} in trash` : ''}
          </span>
        </div>

        <p className="mb-3 text-xs text-muted-foreground">
          Archiving takes a conversation out of the sidebar and puts its process to sleep. It runs
          immediately and undoes in a click. The recycle bin is the only step that removes anything,
          and it always asks first.
        </p>

        <div className="space-y-1 text-xs">
          <div className="flex items-center gap-2 rounded-md px-1 py-1">
            <Archive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1">Idle &gt; {cfg?.cleanupIdleDays ?? preview?.defaults.archiveIdleDays}d — archive + sleep</span>
            <span className="tabular-nums">{archiveN}</span>
          </div>
          <div className="flex items-center gap-2 rounded-md px-1 py-1">
            <Trash2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1">Proposed for the bin (you confirm)</span>
            <span className="tabular-nums">{trashN}</span>
          </div>
          {sparedN > 0 && (
            <div className="flex items-center gap-2 rounded-md px-1 py-1 text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">Old enough, but spared</span>
              <span className="tabular-nums">{sparedN}</span>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs">
          <label className="flex items-center gap-1.5 text-muted-foreground">
            Auto-archive idle &gt;
            <input
              type="number"
              min={1}
              key={cfg?.cleanupIdleDays ?? 'off'}
              defaultValue={cfg?.cleanupIdleDays ?? ''}
              onBlur={(e) => {
                const v = e.target.value.trim();
                setConfig.mutate({ cleanupIdleDays: v ? Math.max(1, Math.round(Number(v))) : null });
              }}
              className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-right text-foreground tabular-nums"
            />
            d <span className="text-muted-foreground/60">(blank = off)</span>
          </label>
          <button
            type="button"
            onClick={() => void runCleanup()}
            disabled={busy || archiveN + trashN === 0}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer disabled:opacity-50"
          >
            <Brush className="h-3.5 w-3.5" />
            {busy ? 'Cleaning…' : 'Clean up'}
          </button>
        </div>

        {host?.transcriptTotalMb != null && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Transcripts on disk: {(host.transcriptTotalMb / 1024).toFixed(1)} GB over {host.transcriptCount} files
            {host.transcriptOrphanCount != null && (
              <> · {host.transcriptOrphanCount} not tied to any session ({((host.transcriptOrphanMb ?? 0) / 1024).toFixed(1)} GB)</>
            )}
            . Counted, never swept — this folder also holds your own terminal claude history, and nothing on
            disk tells the two apart. A session&rsquo;s transcript is deleted when it is purged.
          </p>
        )}

        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            {cfg?.lastCleanupAt
              ? `Last run ${fmtAgo(cfg.lastCleanupAt)}${cfg.lastCleanupSummary ? ` — archived ${cfg.lastCleanupSummary.archived ?? 0}, binned ${cfg.lastCleanupSummary.trashed ?? 0}${cfg.lastCleanupSummary.auto ? ' (auto)' : ''}` : ''}`
              : 'Never run'}
          </span>
          <button type="button" onClick={() => setShowTrash((v) => !v)} className="underline-offset-2 hover:underline cursor-pointer">
            {showTrash ? 'Hide trash' : `Trash${(preview?.trashed ?? 0) > 0 ? ` (${preview?.trashed})` : ''}`}
          </button>
        </div>

        {showTrash && (
          <div className="mt-3 space-y-0.5 border-t border-border pt-3">
            {(trash?.rows.length ?? 0) === 0 && <p className="py-2 text-xs text-muted-foreground">The bin is empty.</p>}
            {trash?.rows.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded-md px-1 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{r.agentName}</span>
                  <span className="text-muted-foreground"> · {r.title || r.preview || 'untitled'}</span>
                </span>
                <span className="hidden shrink-0 text-muted-foreground/70 sm:inline">{REASON_LABEL[r.trashReason ?? ''] ?? r.trashReason}</span>
                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{fmtAgo(r.trashedAt)}</span>
                <button
                  type="button"
                  title="Restore"
                  onClick={() => restore.mutate({ id: r.id })}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="Delete now — irreversible"
                  onClick={async () => {
                    if (await confirm({
                      title: 'Delete permanently?',
                      message: 'The conversation, its messages and its transcript are gone. This cannot be undone.',
                      confirmLabel: 'Delete',
                      danger: true,
                    })) purgeNow.mutate({ id: r.id });
                  }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-rose-500 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {trash && trash.rows.length > 0 && (
              <p className="pt-1 text-[11px] text-muted-foreground">
                Purged automatically after {trash.retainDays} days in the bin.
              </p>
            )}
          </div>
        )}
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Popup
            data-slot="dialog-content"
            className="fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none sm:max-w-lg"
          >
            <div>
              <p className="text-sm font-semibold">Move {picked.size} to the recycle bin?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Archived {apply.data?.archived ?? 0} already — that undoes in a click.
                These below still hold their conversation; they sit in the bin for {cfg?.trashRetainDays ?? 14} days
                before anything is actually deleted.
              </p>
            </div>

            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {(preview?.trash ?? []).map((v: Verdict) => (
                <label key={v.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-xs hover:bg-muted/50">
                  <input
                    type="checkbox"
                    checked={picked.has(v.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(v.id); else next.delete(v.id);
                      setPicked(next);
                    }}
                    className="h-3.5 w-3.5 shrink-0 accent-foreground"
                  />
                  <SessionLine v={v} />
                  <span className="hidden shrink-0 text-muted-foreground/70 sm:inline">{REASON_LABEL[v.reason] ?? v.reason}</span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{fmtIdle(v.idleDays)}</span>
                </label>
              ))}
            </div>

            {sparedN > 0 && (
              <details className="rounded-md bg-muted/40 px-2 py-1.5 text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  {sparedN} old enough to clean, left alone — why
                </summary>
                <div className="mt-1.5 space-y-0.5">
                  {(preview?.spared ?? []).map((v: Verdict) => (
                    <div key={v.id} className="flex items-center gap-2 py-0.5">
                      <SessionLine v={v} />
                      <span className="shrink-0 text-muted-foreground/70">{BLOCKER_LABEL[v.blockedBy ?? ''] ?? v.blockedBy}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            <div className="-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-3 sm:flex-row sm:justify-end">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="ghost" size="sm" onClick={() => void keepAll()} disabled={keep.isPending}>
                Keep all — stop proposing these
              </Button>
              <Button size="sm" onClick={() => void confirmTrash()} disabled={picked.size === 0 || trashSessions.isPending}>
                {trashSessions.isPending ? 'Moving…' : `Move ${picked.size} to bin`}
              </Button>
            </div>
          </DialogPrimitive.Popup>
        </DialogPortal>
      </Dialog>
    </>
  );
}
