'use client';

// Global Memory — a single shared note every agent loads. Saved to the DB here;
// each machine's gateway mirrors it into that host's ~/.claude/CLAUDE.md (a
// managed block) so Claude Code injects it into every session.

import { useState } from 'react';
import { Loader2, Save, Brain } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SettingsTabs } from '@/components/settings-tabs';
import { relTime } from '@/lib/format';

export default function GlobalMemoryPage() {
  const utils = trpc.useUtils();
  const q = trpc.globalMemory.get.useQuery();
  const me = trpc.machines.me.useQuery();
  const machineName = me.data?.alias || me.data?.name || '当前机器';
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
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="max-w-3xl w-full mx-auto flex-1 min-h-0 flex flex-col p-4 sm:p-6 gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 text-xs text-muted-foreground min-w-0">
              <Brain className="h-4 w-4 mt-0.5 shrink-0" />
              <p>
                <span className="font-medium text-foreground/80">每台机器单独一份</span>。当前编辑的是机器{' '}
                <span className="font-mono text-foreground/80">{machineName}</span>——它会被该机上<span className="font-medium text-foreground/80">所有 agent</span>加载（网关写进这台机器的{' '}
                <code className="font-mono">~/.claude/CLAUDE.md</code> 受管段落，Claude Code 每会话自动注入）。改完点保存，约 30 秒内同步，对之后启动的会话生效。切换机器（左上角工作区）即编辑那台的。
              </p>
            </div>
            <label className="flex shrink-0 items-center gap-2 pt-0.5 text-xs cursor-pointer select-none">
              <span className={enabled ? 'font-medium text-foreground/80' : 'text-muted-foreground'}>载入到 agent</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label="开启或关闭载入 global memory"
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
              已关闭——agent 不会载入这个文件（各机网关会把它从 <code className="font-mono">~/.claude/CLAUDE.md</code> 移除）。内容已保留，开启后恢复。
            </div>
          )}

          <textarea
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            disabled={q.isPending}
            spellCheck={false}
            placeholder="所有 agent 共享的全局记忆（Markdown）。例如：通用偏好、命名约定、当前重点……"
            className="flex-1 min-h-[300px] w-full rounded-md border border-border bg-background p-3 font-mono text-[13px] leading-relaxed outline-none focus:border-foreground/30 resize-none"
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
        </div>
      </div>
    </div>
  );
}
