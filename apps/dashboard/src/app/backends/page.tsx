'use client';

// Settings → Backends. Which of the runtimes this machine offers when you start
// a chat or set an agent's default.
//
// Per machine, not per fleet, because availability genuinely is: codex needs
// `codex login` on that host and pi needs its endpoint configured, so a
// fleet-wide switch would offer backends that cannot run. The switcher's
// current machine is the one being edited — the same scoping every other
// settings page here uses.

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsTabs } from '@/components/settings-tabs';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { BACKEND_OPTIONS, BACKEND_BLURB, backendLabel, type BackendOption } from '@/lib/runtime-labels';
import { isBackendEnabled, toggleBackend } from '@/lib/backend-availability';

/** What each card is for, beyond the one-liner the picker already shows. */
const NEEDS: Record<BackendOption, string> = {
  'claude-tmux': 'Always available — needs no per-machine setup beyond Claude Code itself.',
  'pi-rpc': 'Needs pi or omp installed, and an endpoint configured under Pi Runtime.',
  'codex-exec': 'Needs the codex CLI installed and `codex login` completed as the gateway’s user.',
  'dsh-exec': 'Needs DeepSeek Harness (dsh) installed and DEEPSEEK_API_KEY in the secret store.',
};

export default function BackendsPage() {
  const utils = trpc.useUtils();
  const cfg = trpc.machines.getBackendsConfig.useQuery();
  const save = trpc.machines.setBackendsConfig.useMutation({
    onSuccess: () => {
      // The picker reads the same query, so invalidating here is what makes a
      // toggle show up in an already-open new-chat screen.
      void utils.machines.getBackendsConfig.invalidate();
    },
  });
  const [err, setErr] = useState<string | null>(null);

  function onToggle(option: BackendOption, enabled: boolean) {
    const next = toggleBackend(cfg.data, option, enabled);
    if (!next) {
      setErr('At least one backend has to stay enabled — otherwise there is nothing to start a chat on.');
      return;
    }
    setErr(null);
    save.mutate({ config: next });
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="backends" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
          <p className="mb-4 text-xs text-muted-foreground">
            Which backends the <span className="font-medium text-foreground/80">currently selected machine</span> offers.
            Switching one off hides it from the new-chat picker and from an agent’s default —
            it does not stop a session already running on it, and that session keeps showing
            its own backend so the picker never misrepresents what is running.
          </p>

          {cfg.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : (
            <Card className="divide-y divide-border p-0">
              {BACKEND_OPTIONS.map((option) => {
                const on = isBackendEnabled(option, cfg.data);
                return (
                  <div key={option} className="flex items-start gap-3 p-3 sm:p-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">{backendLabel(option)}</div>
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        {BACKEND_BLURB[option]}
                      </p>
                      <p className="mt-1 text-[11px] leading-snug text-muted-foreground/70">{NEEDS[option]}</p>
                    </div>
                    {/* Same switch markup as Global Memory's — there is no
                        shared ui/switch in this app, and inventing a second
                        toggle style for one page is how two of them drift. */}
                    <label className="flex shrink-0 items-center gap-2 pt-0.5 text-xs cursor-pointer select-none">
                      <span className={on ? 'font-medium text-emerald-600' : 'text-muted-foreground'}>
                        {on ? 'On' : 'Off'}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={`${backendLabel(option)} enabled`}
                        disabled={save.isPending || cfg.isPending}
                        onClick={() => onToggle(option, !on)}
                        className={cn(
                          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
                          on ? 'bg-emerald-500' : 'bg-muted-foreground/30',
                        )}
                      >
                        <span className={cn(
                          'inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                          on ? 'translate-x-4' : 'translate-x-0.5',
                        )} />
                      </button>
                    </label>
                  </div>
                );
              })}
            </Card>
          )}

          {err && <p className="mt-3 text-xs text-rose-500">{err}</p>}
          {save.error && <p className="mt-3 text-xs text-rose-500">{save.error.message}</p>}
        </div>
      </div>
    </div>
  );
}
