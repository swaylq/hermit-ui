'use client';

// Gateway card — Settings → System. When this machine's gateway last started,
// and the two things you can do to it from here: pull its checkout up to origin
// and restart it onto that code, or just restart it.
//
// Both are queued as a MachineRequest and run BY the gateway on its own host
// (the dashboard runs on a VPS and cannot touch the machine), which means the
// gateway is the process carrying out its own restart. It acks first and hands
// the restart to a detached `pm2 restart` — see the gateway's machine-requests.
//
// The cost is stated on the button, not in a doc: a gateway restart kills every
// session on that machine, each losing whatever turn it was mid-way through.
// That is why this asks twice.

import { useState } from 'react';
import { ArrowUpCircle, RotateCw, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type OpRow = {
  status: string;
  output: string | null;
  error: string | null;
  requestedAt: string | Date;
  resolvedAt: string | Date | null;
  // Server's verdict: `running`, but for long enough that the gateway is not
  // coming back to finish it. Both ops here end by killing the process that
  // would have reported — a gateway that dies a breath too early leaves exactly
  // this row, and without the flag the button spins for good.
  stale: boolean;
};

const inFlight = (r: OpRow | null | undefined) =>
  !!r && !r.stale && (r.status === 'pending' || r.status === 'running');

function fmtExact(d: string | Date | null | undefined): string | undefined {
  if (!d) return undefined;
  const t = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(t.getTime()) ? undefined : t.toLocaleString();
}

// Last run of one op: state, when, and whatever the host printed.
function OpResult({ row }: { row: OpRow }) {
  const label =
    row.stale ? 'No result' :
    row.status === 'pending' ? 'Queued' :
    row.status === 'running' ? 'Running' :
    row.status === 'done' ? 'Done' : 'Failed';
  const tone =
    row.stale ? 'text-amber-500' :
    row.status === 'done' ? 'text-emerald-500' :
    row.status === 'error' ? 'text-rose-500' :
    row.status === 'running' ? 'text-sky-500' : 'text-muted-foreground';
  return (
    <div className="rounded-md bg-muted/40 p-2.5 space-y-1.5 text-xs animate-in fade-in-0">
      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center gap-1 font-medium', tone)}>
          {inFlight(row) ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : row.status === 'done' ? <CheckCircle2 className="h-3.5 w-3.5" />
            : <XCircle className="h-3.5 w-3.5" />}
          {label}
        </span>
        <span className="text-muted-foreground/60" title={fmtExact(row.resolvedAt ?? row.requestedAt)}>
          {relTime(row.resolvedAt ?? row.requestedAt)}
        </span>
      </div>
      {row.stale && (
        <p className="text-muted-foreground">
          It started and never reported back — most likely the gateway restarted before it could. Safe to run again.
        </p>
      )}
      {row.error && <p className="text-rose-400 break-words">{row.error}</p>}
      {row.output && (
        <pre className="max-h-48 overflow-auto rounded bg-background/60 p-2 text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/80">
          {row.output}
        </pre>
      )}
    </div>
  );
}

export function GatewayCard() {
  const utils = trpc.useUtils();
  // Same queries (and keys) the host-health card above already runs, so this
  // card adds no requests of its own — react-query serves both from one.
  const startedAt = trpc.hosts.stat.useQuery(undefined, { refetchInterval: 10_000 }).data?.stat?.gatewayStartedAt ?? null;
  const sessions = trpc.hosts.topSessions.useQuery(undefined, { refetchInterval: 10_000 }).data ?? [];
  const liveCount = sessions.filter((s) => s.alive).length;

  const ops = trpc.machines.opsStatus.useQuery(undefined, { refetchInterval: 5_000 });
  const updateRow = ops.data?.updateGateway ?? null;
  const restartRow = ops.data?.restartGateway ?? null;

  const onQueued = () => void utils.machines.opsStatus.invalidate();
  const update = trpc.machines.requestUpdateGateway.useMutation({ onSuccess: onQueued });
  const restart = trpc.machines.requestRestartGateway.useMutation({ onSuccess: onQueued });
  const [confirm, setConfirm] = useState(false);
  // A queue call that FAILS produces no row at all, so without this the button
  // just snaps back and a confirmed restart looks identical to a mis-click.
  const queueError = (m: { error: { message: string } | null }) => m.error?.message ?? null;

  const updateBusy = update.isPending || inFlight(updateRow);
  const restartBusy = restart.isPending || inFlight(restartRow);

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-semibold">Gateway</span>
        <span className="text-xs text-muted-foreground" title={fmtExact(startedAt)}>
          {startedAt ? `restarted ${relTime(startedAt)}` : 'restart time unknown'}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        {startedAt
          ? 'The process on this machine that runs every session, cron and file operation. It reports its own start time every ~30s.'
          : 'The start time appears here after this machine’s gateway next restarts — an older gateway does not report it.'}
      </p>

      <div className="mt-3 space-y-3">
        <div className="flex items-start gap-3">
          <ArrowUpCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Update to latest</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pulls this machine&apos;s hermit-ui checkout up to origin, installs dependencies if they moved, then
              restarts the gateway onto the new code. Already up to date means no restart at all.
            </p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0" disabled={updateBusy} onClick={() => update.mutate()}>
            {updateBusy ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…</> : 'Update'}
          </Button>
        </div>
        {queueError(update) && <p className="text-xs text-rose-400">Could not queue it: {queueError(update)}</p>}
        {updateRow && <OpResult row={updateRow} />}

        <div className="flex items-start gap-3">
          <RotateCw className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Restart gateway</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Kills {liveCount > 0 ? `the ${liveCount} session${liveCount === 1 ? '' : 's'} running` : 'every session'} on
              this machine — each loses the turn it is mid-way through and resumes, with its history, on the next
              message. Chat is down for a few seconds. Use it when the gateway is stuck, not as a habit.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className={cn('shrink-0', confirm && 'border-rose-500/50 text-rose-500 hover:bg-rose-500/10')}
            disabled={restartBusy}
            onClick={() => {
              // Two taps, and the armed state lapses on its own — the same shape
              // Ops uses for "restart every session", for the same reason.
              if (!confirm) {
                setConfirm(true);
                window.setTimeout(() => setConfirm(false), 4000);
                return;
              }
              setConfirm(false);
              restart.mutate();
            }}
          >
            {restartBusy ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Restarting…</> : confirm ? 'Confirm restart' : 'Restart'}
          </Button>
        </div>
        {queueError(restart) && <p className="text-xs text-rose-400">Could not queue it: {queueError(restart)}</p>}
        {restartRow && <OpResult row={restartRow} />}
      </div>
    </Card>
  );
}
