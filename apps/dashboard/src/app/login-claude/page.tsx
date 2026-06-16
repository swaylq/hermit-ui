'use client';

import { useState } from 'react';
import { KeyRound, Loader2, CheckCircle2, XCircle, AlertTriangle, Hand, RotateCcw } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SettingsTabs } from '@/components/settings-tabs';

// Statuses that mean "still working" — poll while in one of them, idle otherwise.
const ACTIVE = new Set(['pending', 'running', 'needs-human']);

type LoginRow = {
  status: string;
  output: string | null;
  error: string | null;
  requestedAt: string | Date;
  resolvedAt: string | Date | null;
};

// Parse "email----emailPassword----mailToken----claudeSk". The `claudeSk` is
// intentionally dropped HERE (client-side) — it never leaves the browser.
function parseAccountLine(line: string): { email: string; mailToken: string; emailPassword?: string } | null {
  const p = line.split('----').map((s) => s.trim());
  const email = p[0] || '';
  const emailPassword = p[1] || '';
  const mailToken = p[2] || '';
  if (!email || !mailToken) return null;
  return { email, mailToken, ...(emailPassword ? { emailPassword } : {}) };
}

function LoginResult({ row }: { row: LoginRow }) {
  const meta: Record<string, { cls: string; label: string }> = {
    pending: { cls: 'text-muted-foreground', label: '排队中' },
    running: { cls: 'text-sky-500', label: '登录中' },
    'needs-human': { cls: 'text-amber-500', label: '需要人工' },
    done: { cls: 'text-emerald-500', label: '完成' },
    error: { cls: 'text-rose-500', label: '失败' },
  };
  const m = meta[row.status] ?? meta.pending;
  const spin = row.status === 'pending' || row.status === 'running';
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2.5 space-y-1.5 text-xs">
      {row.status === 'needs-human' && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400">
          <Hand className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            需要你到<span className="font-medium">那台 Mac 的 Chrome 窗口</span>里完成这一步（多半是 Cloudflare 人机验证 / 登录），完成后会自动继续。
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center gap-1 font-medium', m.cls)}>
          {spin ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : row.status === 'needs-human' ? (
            <AlertTriangle className="h-3.5 w-3.5" />
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

export default function LoginClaudePage() {
  const utils = trpc.useUtils();
  const status = trpc.machines.loginStatus.useQuery(undefined, {
    refetchInterval: (q) => (ACTIVE.has((q.state.data as LoginRow | null | undefined)?.status ?? '') ? 2_500 : false),
  });
  const start = trpc.machines.requestLoginClaude.useMutation({
    onSuccess: () => {
      setLine('');
      utils.machines.loginStatus.invalidate();
    },
  });
  const reset = trpc.machines.resetLogin.useMutation({
    onSuccess: () => utils.machines.loginStatus.invalidate(),
  });
  const [line, setLine] = useState('');
  const [err, setErr] = useState('');

  const row = (status.data ?? null) as LoginRow | null;
  const busy = start.isPending || (!!row && ACTIVE.has(row.status));

  const submit = () => {
    setErr('');
    const parsed = parseAccountLine(line);
    if (!parsed) {
      setErr('格式不对，应为：邮箱----邮箱密码----接码令牌----Claude Sk');
      return;
    }
    start.mutate(parsed);
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="login" />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto p-4 sm:p-6 space-y-4">
          <p className="text-xs text-muted-foreground">
            把<span className="font-medium text-foreground/80">当前选中的机器</span>的 Claude Code 登录到指定账号。会在那台 Mac
            上弹出 Chrome 自动完成 claude.ai 登录（验证码走 171mail）+ <code className="font-mono">claude auth login</code>。
          </p>

          <Card className="p-4 space-y-3">
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="text-sm font-semibold text-foreground">登录 Claude Code 账号</div>
                <p className="text-xs text-muted-foreground">
                  粘贴成品号一行：<code className="font-mono">邮箱----邮箱密码----接码令牌----Claude Sk</code>。提交后输入框即清空、
                  <span className="text-foreground/80">不保存</span>；其中 <code className="font-mono">Claude Sk</code>{' '}
                  在浏览器里就丢弃，不会发往服务器。
                </p>
                <textarea
                  value={line}
                  onChange={(e) => setLine(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="邮箱----邮箱密码----接码令牌----sk-ant-sid02-…"
                  className="w-full rounded-md bg-background border border-border px-2.5 py-2 text-xs font-mono outline-none focus:border-foreground/30 resize-y"
                />
                {err && <p className="text-[11px] text-rose-400">{err}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" disabled={busy || !line.trim()} onClick={submit}>
                    {busy ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> 登录中…
                      </>
                    ) : (
                      '开始登录'
                    )}
                  </Button>
                  {busy && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={reset.isPending}
                      onClick={() => reset.mutate()}
                      className="border-rose-500/40 text-rose-500 hover:bg-rose-500/10"
                    >
                      {reset.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5 mr-1" />
                      )}
                      卡住了？重置
                    </Button>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    需要那台 Mac 处于桌面登录态（会弹有头 Chrome；蹦验证码时要人工点一下）。
                  </span>
                </div>
              </div>
            </div>

            {row && <LoginResult row={row} />}
          </Card>
        </div>
      </div>
    </div>
  );
}
