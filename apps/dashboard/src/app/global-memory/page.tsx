'use client';

// Global Memory — a per-machine inline note + a folder of files, all loaded by
// every agent on this machine. The note (a managed block) and each text file
// (an @import) are mirrored into this host's ~/.claude/CLAUDE.md by its gateway,
// so Claude Code injects them into every session. The note and the files are
// now edited TOGETHER in one explorer: the inline note is its first entry, edited
// like any other file (it just persists to the DB block, not the folder).

import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { SettingsTabs } from '@/components/settings-tabs';
import { GlobalMemoryFiles } from '@/components/global-memory-files';

export default function GlobalMemoryPage() {
  const utils = trpc.useUtils();
  const q = trpc.globalMemory.get.useQuery();
  const me = trpc.machines.me.useQuery();
  const machineName = me.data?.alias || me.data?.name || 'this machine';
  const setEnabled = trpc.globalMemory.setEnabled.useMutation({
    onSuccess: () => utils.globalMemory.get.invalidate(),
  });
  const enabled = q.data?.enabled ?? true;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="memory" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto p-4 sm:p-6 flex flex-col gap-4">
          {/* Header: title + on/off, with a compact one-line description */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">Global Memory</h2>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                Loaded by every agent on <span className="font-mono text-foreground/80">{machineName}</span> · imported into{' '}
                <code className="font-mono">~/.claude/CLAUDE.md</code> · per-machine (switch top-left)
              </p>
            </div>
            <label className="flex shrink-0 items-center gap-2 pt-0.5 text-xs cursor-pointer select-none">
              <span className={enabled ? 'font-medium text-emerald-600' : 'text-muted-foreground'}>{enabled ? 'On' : 'Off'}</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label="load global memory into agents"
                disabled={setEnabled.isPending || q.isPending}
                onClick={() => setEnabled.mutate({ enabled: !enabled })}
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
                  enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30',
                )}
              >
                <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform', enabled ? 'translate-x-4' : 'translate-x-0.5')} />
              </button>
            </label>
          </div>

          {!enabled && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600">
              Off — agents won&apos;t load this. The note and files are kept; turn on to restore.
            </div>
          )}

          {/* One explorer for the inline note + the ~/.claude/global-memory folder. */}
          <section className="flex flex-col gap-2 min-h-[460px]">
            <GlobalMemoryFiles />
          </section>
        </div>
      </div>
    </div>
  );
}
