'use client';

// Global Memory — a per-machine note + a folder, both loaded by every agent on
// this machine. The inline note and the folder's text files are mirrored into
// this host's ~/.claude/CLAUDE.md by its gateway (the note as a managed block,
// each file as an `@import`), so Claude Code injects them into every session.

import { useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SettingsTabs } from '@/components/settings-tabs';
import { GlobalMemoryFiles } from '@/components/global-memory-files';
import { relTime } from '@/lib/format';

export default function GlobalMemoryPage() {
  const utils = trpc.useUtils();
  const q = trpc.globalMemory.get.useQuery();
  const me = trpc.machines.me.useQuery();
  const machineName = me.data?.alias || me.data?.name || 'this machine';
  // null = untouched (mirror the server value); a string = local edits.
  const [draft, setDraft] = useState<string | null>(null);
  const save = trpc.globalMemory.set.useMutation({
    onSuccess: () => utils.globalMemory.get.invalidate(),
  });
  const setEnabled = trpc.globalMemory.setEnabled.useMutation({
    onSuccess: () => utils.globalMemory.get.invalidate(),
  });

  const serverContent = q.data?.content ?? '';
  const value = draft ?? serverContent;
  const dirty = draft !== null && draft !== serverContent;
  const enabled = q.data?.enabled ?? true;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="memory" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto p-4 sm:p-6 flex flex-col gap-4">
          {/* Intro + on/off */}
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-muted-foreground min-w-0">
              Loaded by every agent on <span className="font-mono text-foreground/80">{machineName}</span>. Edit the note below, or
              add files to the folder — both are imported into this machine&apos;s <code className="font-mono">~/.claude/CLAUDE.md</code>.
              Per-machine; switch machines (top-left) to edit another.
            </p>
            <label className="flex shrink-0 items-center gap-2 pt-0.5 text-xs cursor-pointer select-none">
              <span className={enabled ? 'font-medium text-emerald-600' : 'text-muted-foreground'}>{enabled ? 'on' : 'off'}</span>
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

          {/* Inline note (the managed block in CLAUDE.md) */}
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide">Inline note</h3>
            <textarea
              value={value}
              onChange={(e) => setDraft(e.target.value)}
              disabled={q.isPending}
              spellCheck={false}
              placeholder="A global note every agent loads (Markdown). e.g. shared preferences, naming conventions, current focus…"
              className="min-h-[180px] w-full rounded-md border border-border bg-background p-3 font-mono text-[13px] leading-relaxed outline-none focus:border-foreground/30 resize-y"
            />
            <div className="flex items-center gap-3">
              <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate({ content: value })}>
                {save.isPending ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> 保存中…</>
                ) : (
                  <><Save className="h-3.5 w-3.5 mr-1" /> 保存</>
                )}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {save.isError ? (
                  <span className="text-rose-500">{save.error.message}</span>
                ) : dirty ? (
                  '有未保存的修改'
                ) : q.data?.updatedAt ? (
                  `已保存 · ${relTime(q.data.updatedAt)}`
                ) : (
                  '尚未设置'
                )}
              </span>
              <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/60">{value.length} 字符</span>
            </div>
          </section>

          {/* Memory files (the ~/.claude/global-memory folder, @imported into CLAUDE.md) */}
          <section className="flex flex-col gap-2 min-h-[400px]">
            <h3 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide">Memory files</h3>
            <p className="text-[11px] text-muted-foreground -mt-1">
              Text files here (<code className="font-mono">.md</code>, <code className="font-mono">.txt</code>) are referenced into <code className="font-mono">~/.claude/CLAUDE.md</code> as <code className="font-mono">@imports</code>.
            </p>
            <GlobalMemoryFiles />
          </section>
        </div>
      </div>
    </div>
  );
}
