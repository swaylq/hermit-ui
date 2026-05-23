'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { trpc } from '@/lib/trpc';
import { relTime } from '@/lib/format';

type Status = 'ok' | 'fail' | 'running' | 'unknown';

const statusStyle: Record<Status, string> = {
  ok: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/15',
  fail: 'text-rose-300 border-rose-500/30 bg-rose-500/15',
  running: 'text-amber-300 border-amber-400/30 bg-amber-400/15',
  unknown: 'text-zinc-400 border-zinc-700 bg-zinc-700/30',
};

function fmtInterval(s: number): string {
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

export function SystemTasksSection({ agentName }: { agentName: string }) {
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const q = trpc.tasks.systemList.useQuery({ agentName }, { refetchInterval: 5000 });

  const create = trpc.tasks.systemCreate.useMutation({
    onSuccess: () => {
      void utils.tasks.systemList.invalidate();
      setShowForm(false);
    },
  });
  const runNow = trpc.tasks.systemRunNow.useMutation({
    onSuccess: () => void utils.tasks.systemList.invalidate(),
  });
  const del = trpc.tasks.systemDelete.useMutation({
    onSuccess: () => void utils.tasks.systemList.invalidate(),
  });
  const update = trpc.tasks.systemUpdate.useMutation({
    onSuccess: () => void utils.tasks.systemList.invalidate(),
  });

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
          system tasks · {q.data?.length ?? 0}
        </h3>
        <Button size="sm" variant="outline" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'cancel' : '+ new task'}
        </Button>
      </div>

      {showForm && (
        <TaskForm
          agentName={agentName}
          submitting={create.isPending}
          onSubmit={(v) => create.mutate(v)}
        />
      )}

      <div className="space-y-2">
        {q.data?.length === 0 && !showForm && (
          <p className="text-xs text-muted-foreground">no tasks yet — click + new task above.</p>
        )}
        {q.data?.map((t) => {
          const status = (t.lastStatus as Status | null) ?? 'unknown';
          const isExpanded = expandedId === t.id;
          return (
            <Card key={t.id} className="p-2.5 space-y-1.5">
              <button
                className="w-full flex items-center justify-between gap-2 text-left"
                onClick={() => setExpandedId(isExpanded ? null : t.id)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant="outline" className={`${statusStyle[status]} font-mono text-[10px] shrink-0`}>
                    {status}
                  </Badge>
                  <span className="font-mono text-xs truncate">{t.name}</span>
                  {!t.enabled && (
                    <Badge variant="outline" className="font-mono text-[10px] text-zinc-500">
                      disabled
                    </Badge>
                  )}
                </div>
                <div className="flex flex-col items-end text-[10px] font-mono text-muted-foreground shrink-0">
                  <span>every {fmtInterval(t.intervalSec)}</span>
                  <span>{relTime(t.lastFire)}</span>
                </div>
              </button>

              {isExpanded && (
                <>
                  <Separator />
                  <div className="space-y-2 text-xs">
                    <div className="flex flex-wrap gap-2 text-[10px] font-mono text-muted-foreground">
                      {t.lastDurationMs != null && <span>last run: {(t.lastDurationMs / 1000).toFixed(1)}s</span>}
                      {t.happySessionId && (
                        <span className="break-all">
                          happy: {t.happySessionId.slice(0, 12)}…
                        </span>
                      )}
                      {t.directory && <span className="break-all">dir: {t.directory}</span>}
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">prompt</div>
                      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed max-h-40 overflow-auto p-2 rounded bg-muted/30">
                        {t.prompt}
                      </pre>
                    </div>
                    {t.lastOutput && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">last output (tail)</div>
                        <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed max-h-48 overflow-auto p-2 rounded bg-muted/30">
                          {t.lastOutput}
                        </pre>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => runNow.mutate({ id: t.id })}
                        disabled={runNow.isPending || status === 'running'}
                      >
                        run now
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => update.mutate({ id: t.id, enabled: !t.enabled })}
                      >
                        {t.enabled ? 'disable' : 'enable'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-rose-300 hover:text-rose-200"
                        onClick={() => {
                          if (confirm(`delete task "${t.name}"?`)) del.mutate({ id: t.id });
                        }}
                      >
                        delete
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function TaskForm({
  agentName,
  submitting,
  onSubmit,
}: {
  agentName: string;
  submitting: boolean;
  onSubmit: (v: { agentName: string; name: string; prompt: string; intervalSec: number; directory?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [intervalUnit, setIntervalUnit] = useState<'m' | 'h'>('m');
  const [intervalValue, setIntervalValue] = useState(30);
  const [directory, setDirectory] = useState('');
  const [prompt, setPrompt] = useState('');

  const intervalSec = intervalUnit === 'h' ? intervalValue * 3600 : intervalValue * 60;

  return (
    <Card className="p-3 mb-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wide text-muted-foreground">name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
            placeholder={`${agentName}-…`}
            className="font-mono text-xs"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-muted-foreground">interval</label>
          <div className="flex gap-1">
            <Input
              type="number"
              min={1}
              value={intervalValue}
              onChange={(e) => setIntervalValue(Math.max(1, Number(e.target.value) || 1))}
              className="font-mono text-xs"
            />
            <select
              value={intervalUnit}
              onChange={(e) => setIntervalUnit(e.target.value as 'm' | 'h')}
              className="bg-input border border-input rounded px-2 text-xs"
            >
              <option value="m">min</option>
              <option value="h">hour</option>
            </select>
          </div>
        </div>
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          directory (optional, defaults to /Users/mac/claudeclaw/{agentName})
        </label>
        <Input
          value={directory}
          onChange={(e) => setDirectory(e.target.value)}
          placeholder={`/Users/mac/claudeclaw/${agentName}`}
          className="font-mono text-xs"
        />
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          className="w-full bg-input border border-input rounded p-2 font-mono text-xs"
          placeholder="What should the agent do each fire?"
        />
      </div>
      <div className="text-[10px] text-muted-foreground">
        fires every {intervalValue}{intervalUnit} ({intervalSec}s) via{' '}
        <code>cd {directory || `/Users/mac/claudeclaw/${agentName}`} && happy --yolo [--continue] -p ...</code>
      </div>
      <Button
        size="sm"
        disabled={submitting || !name || !prompt}
        onClick={() =>
          onSubmit({
            agentName,
            name,
            prompt,
            intervalSec,
            directory: directory || undefined,
          })
        }
      >
        {submitting ? 'creating…' : 'create task'}
      </Button>
    </Card>
  );
}
