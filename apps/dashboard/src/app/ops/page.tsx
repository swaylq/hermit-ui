'use client';

import { useState } from 'react';
import { ArrowUpCircle, RefreshCw, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SettingsTabs } from '@/components/settings-tabs';

type OpRow = {
  status: string;
  output: string | null;
  error: string | null;
  requestedAt: string | Date;
  resolvedAt: string | Date | null;
};

// Last-run status + captured output for one operation.
function OpResult({ row }: { row: OpRow }) {
  const meta: Record<string, { cls: string; label: string }> = {
    pending: { cls: 'text-muted-foreground', label: '排队中' },
    running: { cls: 'text-sky-500', label: '运行中' },
    done: { cls: 'text-emerald-500', label: '完成' },
    error: { cls: 'text-rose-500', label: '失败' },
  };
  const m = meta[row.status] ?? meta.pending;
  const spin = row.status === 'pending' || row.status === 'running';
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center gap-1 font-medium', m.cls)}>
          {spin ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : row.status === 'done' ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <XCircle className="h-3.5 w-3.5" />
          )}
          {m.label}
        </span>
        <span className="text-muted-foreground/60">{relTime(row.resolvedAt ?? row.requestedAt)}</span>
      </div>
      {row.error && <p className="text-rose-400 break-words">{row.error}</p>}
      {row.output && (
        <pre className="max-h-48 overflow-auto rounded bg-background/60 p-2 text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/80">
          {row.output}
        </pre>
      )}
    </div>
  );
}

export default function OpsPage() {
  const utils = trpc.useUtils();
  // Poll while something is in flight so pending → running → done updates live.
  const ops = trpc.machines.opsStatus.useQuery(undefined, { refetchInterval: 4000 });
  const upgrade = trpc.machines.requestUpgradeClaude.useMutation({ onSuccess: () => utils.machines.opsStatus.invalidate() });
  const restartAll = trpc.machines.requestRestartAllSessions.useMutation({ onSuccess: () => utils.machines.opsStatus.invalidate() });
  const [confirmRestart, setConfirmRestart] = useState(false);

  const upgradeRow = ops.data?.upgrade ?? null;
  const restartRow = ops.data?.restartAll ?? null;
  const upgradeBusy = upgrade.isPending || upgradeRow?.status === 'pending' || upgradeRow?.status === 'running';
  const restartBusy = restartAll.isPending || restartRow?.status === 'pending' || restartRow?.status === 'running';

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="ops" />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto p-4 sm:p-6 space-y-4">
          <p className="text-xs text-muted-foreground">
            以下操作在<span className="font-medium text-foreground/80">当前选中的机器</span>上由网关执行。
          </p>

          {/* Upgrade Claude Code */}
          <Card className="p-4 space-y-3">
            <div className="flex items-start gap-3">
              <ArrowUpCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-foreground">升级 Claude Code</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  在这台机器上运行 <code className="font-mono">claude upgrade</code>,把 Claude Code 升到最新版。升级后建议再「依次重启所有 session」让它们用上新版本。
                </p>
              </div>
              <Button size="sm" disabled={upgradeBusy} onClick={() => upgrade.mutate()} className="shrink-0">
                {upgradeBusy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> 运行中…
                  </>
                ) : (
                  '升级'
                )}
              </Button>
            </div>
            {upgradeRow && <OpResult row={upgradeRow} />}
          </Card>

          {/* Restart all sessions */}
          <Card className="p-4 space-y-3">
            <div className="flex items-start gap-3">
              <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-foreground">依次重启所有 session</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  逐个重启这台机器上所有活跃 session(每个间隔 4 秒、不同时),保留完整历史(<code className="font-mono">claude --resume</code>),下次发消息时恢复。正在回复中的 session 会跳过。
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={restartBusy}
                onClick={() => {
                  if (!confirmRestart) {
                    setConfirmRestart(true);
                    window.setTimeout(() => setConfirmRestart(false), 4000);
                    return;
                  }
                  setConfirmRestart(false);
                  restartAll.mutate();
                }}
                className={cn('shrink-0', confirmRestart && 'border-rose-500/50 text-rose-500 hover:bg-rose-500/10')}
              >
                {restartBusy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> 运行中…
                  </>
                ) : confirmRestart ? (
                  '确认重启全部'
                ) : (
                  '重启全部'
                )}
              </Button>
            </div>
            {restartRow && <OpResult row={restartRow} />}
          </Card>
        </div>
      </div>
    </div>
  );
}
