'use client';

// The machine-health banner: a slim strip at the top of every authed page when
// something on this machine needs the human — messages not reaching the gateway,
// a wedged event loop, runaway load, a reaper that had to kill leaked browsers.
//
// It exists because every one of those conditions used to be silent: the fleet
// had process-level checks (pm2 alive?, host red?) and the human found outages by
// tripping over them. The banner is the visible half of the MachineAlert ledger
// (server/machine-alerts.ts); pushes are the lock-screen half.

import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import { AlertTriangle, X } from 'lucide-react';

const POLL_MS = 30_000;

export function MachineAlertsBanner() {
  const utils = trpc.useUtils();
  const alerts = trpc.alerts.open.useQuery(undefined, { refetchInterval: POLL_MS }).data ?? [];
  const dismiss = trpc.alerts.dismiss.useMutation({
    onSettled: () => utils.alerts.open.invalidate(),
  });

  if (alerts.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5">
      {alerts.map((a) => (
        <div key={a.id} className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {a.linkPath ? (
            // The whole point of the banner: one tap takes you to the stuck
            // session (or /watchdogs) — an alert you cannot act on is noise.
            <Link href={a.linkPath} className="min-w-0 flex-1 truncate hover:underline">
              {a.message}
            </Link>
          ) : (
            <span className="min-w-0 flex-1 truncate">{a.message}</span>
          )}
          <button
            type="button"
            aria-label="dismiss"
            className="shrink-0 rounded p-0.5 hover:bg-destructive/20"
            onClick={() => dismiss.mutate({ id: a.id })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
