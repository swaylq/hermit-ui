'use client';

// Global Memory — a single shared note every agent loads. Saved to the DB here;
// each machine's gateway mirrors it into that host's ~/.claude/CLAUDE.md (a
// managed block) so Claude Code injects it into every session.

import { useState } from 'react';
import { Loader2, Save, Brain } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { SettingsTabs } from '@/components/settings-tabs';
import { relTime } from '@/lib/format';

export default function GlobalMemoryPage() {
  const utils = trpc.useUtils();
  const q = trpc.globalMemory.get.useQuery();
  // null = untouched (mirror the server value); a string = local edits.
  const [draft, setDraft] = useState<string | null>(null);
  const save = trpc.globalMemory.set.useMutation({
    onSuccess: () => utils.globalMemory.get.invalidate(),
  });

  const serverContent = q.data?.content ?? '';
  const value = draft ?? serverContent;
  const dirty = draft !== null && draft !== serverContent;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="memory" />
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="max-w-3xl w-full mx-auto flex-1 min-h-0 flex flex-col p-4 sm:p-6 gap-3">
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <Brain className="h-4 w-4 mt-0.5 shrink-0" />
            <p>
              这个文件会被<span className="font-medium text-foreground/80">所有 agent</span>加载——每台机器的网关把它写进该机的{' '}
              <code className="font-mono">~/.claude/CLAUDE.md</code>（受管段落），Claude Code 在每个会话自动注入。改完点保存，约 30 秒内同步到各机器，对之后启动的会话生效。
            </p>
          </div>

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
