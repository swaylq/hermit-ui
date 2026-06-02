'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Clock, Play, Trash2, Pencil, Check, X, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { SidebarMobileToggle } from '@/components/app-sidebar';

// ── format helpers ───────────────────────────────────────────────────────────
function fmtDur(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}
function fmtEvery(sec: number): string {
  return `every ${fmtDur(sec)}`;
}
function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function CronStatusBadge({ status, enabled }: { status?: string | null; enabled: boolean }) {
  let text = status ?? 'idle';
  let cls = 'text-zinc-400 bg-zinc-500/10 border-zinc-500/25';
  if (!enabled) {
    text = 'off';
  } else if (status === 'ok') {
    cls = 'text-emerald-500 bg-emerald-500/10 border-emerald-500/25';
  } else if (status === 'fail') {
    cls = 'text-rose-500 bg-rose-500/10 border-rose-500/25';
  } else if (status === 'running') {
    cls = 'text-amber-500 bg-amber-500/10 border-amber-500/25';
  }
  return (
    <span className={cn('inline-flex items-center rounded border px-1.5 py-px text-[10px] font-mono uppercase tracking-wide', cls, status === 'running' && enabled && 'animate-pulse')}>
      {text}
    </span>
  );
}

export default function CronPage() {
  return (
    <Suspense fallback={null}>
      <CronPageInner />
    </Suspense>
  );
}

function CronPageInner() {
  const search = useSearchParams();
  const router = useRouter();
  const id = search.get('id');
  const showNew = !!search.get('new');
  const crons = trpc.cron.list.useQuery(undefined, { refetchInterval: 10_000 });

  // Default landing: jump to the first cron so the pane isn't blank (mirrors /agents).
  // Skip while the "New cron" form is open.
  useEffect(() => {
    if (id || showNew) return;
    const first = crons.data?.[0];
    if (first) router.replace(`/cron?id=${encodeURIComponent(first.id)}`);
  }, [id, showNew, crons.data, router]);

  if (showNew) {
    return <NewCronPane />;
  }

  if (!id) {
    return (
      <>
        <header className="border-b border-border px-4 h-12 flex items-center gap-2 shrink-0">
          <SidebarMobileToggle />
          <span className="text-sm font-semibold text-foreground">Cron</span>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 text-muted-foreground">
          <Clock className="h-10 w-10 mb-3 opacity-30" aria-hidden="true" />
          <p className="text-sm">{(crons.data?.length ?? 0) === 0 ? 'No scheduled tasks yet.' : 'Pick a cron from the sidebar.'}</p>
          <p className="mt-1 text-xs">Create one with “New cron”, or “开启定时任务” in a chat.</p>
        </div>
      </>
    );
  }
  return <CronDetail key={id} id={id} />;
}

// ── New cron ─────────────────────────────────────────────────────────────────
// Reached via /cron?new=1 (sidebar "New cron" button). Mirrors the chat "New
// chat" / agents "New agent" create flow: a card form, then a hard navigation
// to the freshly-created cron's detail.
function NewCronPane() {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="border-b border-border px-4 h-12 flex items-center gap-2 shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-semibold text-foreground">New cron</span>
      </header>
      <ScrollArea className="flex-1 min-h-0 bg-background">
        <div className="px-4 py-8 flex justify-center">
          <NewCronForm />
        </div>
      </ScrollArea>
    </div>
  );
}

const CRON_PRESETS: Array<[string, number]> = [['15m', 15], ['1h', 60], ['6h', 360], ['1d', 1440]];

function NewCronForm() {
  const agentsQ = trpc.agents.list.useQuery(undefined, { refetchInterval: 30_000 });
  const utils = trpc.useUtils();

  const [agentName, setAgentName] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [every, setEvery] = useState('60'); // minutes — default hourly
  const [jitter, setJitter] = useState('0'); // minutes

  // Preselect the first agent once the list loads.
  useEffect(() => {
    if (!agentName && agentsQ.data && agentsQ.data.length > 0) setAgentName(agentsQ.data[0].name);
  }, [agentName, agentsQ.data]);

  const create = trpc.cron.create.useMutation({
    onSuccess: (row) => {
      utils.cron.list.invalidate();
      // Hard navigation — a programmatic router.replace to a same-route query
      // change doesn't reliably navigate here (Next 16 + custom server; see
      // chat/page.tsx). window.location lands cleanly on the new cron's detail.
      window.location.href = `/cron?id=${encodeURIComponent(row.id)}`;
    },
  });

  const everyMin = Math.min(10_080, Math.max(1, parseInt(every, 10) || 0)); // 1 min … 7 days
  const jitterMin = Math.min(1_440, Math.max(0, parseInt(jitter, 10) || 0)); // 0 … 1 day
  const promptOk = prompt.trim().length > 0;
  const hasAgents = (agentsQ.data?.length ?? 0) > 0;
  const canSubmit = !!agentName && promptOk && !create.isPending;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    create.mutate({
      agentName,
      title: title.trim() || undefined,
      prompt: prompt.trim(),
      intervalSec: everyMin * 60,
      jitterSec: jitterMin * 60,
    });
  }

  return (
    <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-border bg-card p-6 space-y-5 shadow-sm">
      <div className="text-center space-y-2">
        <div className="mx-auto h-12 w-12 rounded-2xl bg-foreground text-background flex items-center justify-center" aria-hidden="true">
          <Clock className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-medium tracking-tight text-foreground">New cron</h2>
        <p className="text-xs text-muted-foreground">
          a recurring task the gateway fires on schedule in the agent&apos;s directory.
        </p>
      </div>

      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Agent</span>
        {agentsQ.isPending ? (
          <div className="mt-1.5 h-9 rounded-lg bg-accent/40 animate-pulse" />
        ) : !hasAgents ? (
          <p className="mt-1.5 text-xs text-amber-600">no agents yet — create an agent first.</p>
        ) : (
          <Select value={agentName} onValueChange={(v) => setAgentName(v ?? '')} modal={false}>
            <SelectTrigger className="mt-1.5 w-full font-mono" aria-label="agent">
              <SelectValue>{(v: string | null) => v || 'pick an agent'}</SelectValue>
            </SelectTrigger>
            <SelectContent className="font-mono">
              {agentsQ.data?.map((a) => (
                <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </label>

      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
          Title <span className="text-muted-foreground/60 normal-case">(optional)</span>
        </span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 每日早报" className="mt-1.5 text-base sm:text-sm" />
      </label>

      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Prompt</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          placeholder="what should the agent do each time it fires?"
          className="mt-1.5 w-full rounded-md border border-border bg-background p-2 text-[13px] outline-none focus:border-foreground/30 resize-y"
        />
      </label>

      <div className="space-y-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Schedule</span>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">每</span>
          <Input type="number" min={1} value={every} onChange={(e) => setEvery(e.target.value)} className="h-9 w-20" />
          <span className="text-muted-foreground">分钟，浮动 ±</span>
          <Input type="number" min={0} value={jitter} onChange={(e) => setJitter(e.target.value)} className="h-9 w-20" />
          <span className="text-muted-foreground">分钟</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CRON_PRESETS.map(([label, m]) => (
            <button
              key={label}
              type="button"
              onClick={() => setEvery(String(m))}
              className={cn(
                'h-7 px-2.5 rounded-md border text-xs font-mono transition-colors cursor-pointer',
                everyMin === m
                  ? 'border-foreground/30 bg-accent text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground/70">
          fires every {fmtDur(everyMin * 60)}{jitterMin > 0 ? `, jittered ±${fmtDur(jitterMin * 60)}` : ''}. first run on the next gateway tick.
        </p>
      </div>

      {create.error && <p className="text-xs text-rose-500">{create.error.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={!canSubmit} className="flex-1 h-10">
          {create.isPending ? 'creating…' : 'Create cron'}
        </Button>
        {/* Hard navigation — same-pathname query-only nav (?new=1 → /cron) is
            swallowed here for both router AND <Link> (Next 16 + custom server);
            window.location always navigates. Matches the create redirect above. */}
        <Button type="button" variant="ghost" className="h-10" onClick={() => { window.location.href = '/cron'; }}>cancel</Button>
      </div>
    </form>
  );
}

function CronDetail({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const router = useRouter();
  const q = trpc.cron.get.useQuery({ id }, { refetchInterval: 5_000 });
  const update = trpc.cron.update.useMutation({
    onSuccess: () => { utils.cron.get.invalidate({ id }); utils.cron.list.invalidate(); setEditing(false); },
  });
  const del = trpc.cron.delete.useMutation({
    onSuccess: () => { utils.cron.list.invalidate(); router.replace('/cron'); },
  });
  const runNow = trpc.cron.runNow.useMutation({ onSuccess: () => utils.cron.get.invalidate({ id }) });

  const [editing, setEditing] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftEvery, setDraftEvery] = useState('');
  const [draftJitter, setDraftJitter] = useState('');

  const cron = q.data?.cron;
  const runs = q.data?.runs ?? [];

  function startEdit() {
    if (!cron) return;
    setDraftPrompt(cron.prompt);
    setDraftEvery(String(Math.round(cron.intervalSec / 60)));
    setDraftJitter(String(Math.round(cron.jitterSec / 60)));
    setEditing(true);
  }
  function save() {
    const everyMin = Math.max(1, parseInt(draftEvery, 10) || 0);
    const jitterMin = Math.max(0, parseInt(draftJitter, 10) || 0);
    const prompt = draftPrompt.trim();
    if (!prompt) return;
    update.mutate({ id, prompt, intervalSec: everyMin * 60, jitterSec: jitterMin * 60 });
  }

  if (q.isPending) {
    return <div className="p-6"><div className="h-32 rounded-md bg-accent/40 animate-pulse" /></div>;
  }
  if (!cron) {
    return (
      <>
        <header className="border-b border-border px-4 h-12 flex items-center gap-2 shrink-0">
          <SidebarMobileToggle />
          <span className="text-sm font-semibold">Cron</span>
        </header>
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Cron not found.</div>
      </>
    );
  }

  return (
    <>
      <header className="border-b border-border px-4 h-12 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <SidebarMobileToggle />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground truncate">{cron.title || cron.prompt.slice(0, 60)}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground truncate">
              <span className="text-foreground/70">{cron.agentName}</span>
              <span className="text-muted-foreground/40">·</span>
              <span>{fmtEvery(cron.intervalSec)}{cron.jitterSec > 0 ? ` ±${fmtDur(cron.jitterSec)}` : ''}</span>
              <span className="text-muted-foreground/40">·</span>
              <CronStatusBadge status={cron.lastStatus} enabled={cron.enabled} />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="outline" disabled={runNow.isPending} onClick={() => runNow.mutate({ id })} title="run now — fires on the next gateway tick">
            <Play className="size-3.5" /> Run now
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={cn('font-mono text-xs', cron.enabled ? 'text-emerald-600' : 'text-muted-foreground')}
            disabled={update.isPending}
            onClick={() => update.mutate({ id, enabled: !cron.enabled })}
            title={cron.enabled ? 'disable' : 'enable'}
          >
            {cron.enabled ? 'on' : 'off'}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground hover:text-rose-500"
            disabled={del.isPending}
            onClick={() => { if (confirm('Delete this cron and its run history?')) del.mutate({ id }); }}
            title="delete cron"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </header>

      <ScrollArea className="flex-1 min-h-0 bg-background">
        <div className="px-4 py-4 max-w-3xl mx-auto space-y-5">
          <section className="rounded-lg border border-border">
            <div className="flex items-center justify-between px-3 h-9 border-b border-border">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Schedule &amp; prompt</span>
              {!editing ? (
                <Button size="icon-sm" variant="ghost" onClick={startEdit} title="edit schedule & prompt">
                  <Pencil className="size-3.5" />
                </Button>
              ) : (
                <div className="flex gap-1">
                  <Button size="icon-sm" variant="ghost" disabled={update.isPending} onClick={save} title="save">
                    <Check className="size-3.5" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => setEditing(false)} title="cancel">
                    <X className="size-3.5" />
                  </Button>
                </div>
              )}
            </div>
            <div className="p-3 space-y-3 text-[13px]">
              {editing ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">每</span>
                    <Input type="number" min={1} value={draftEvery} onChange={(e) => setDraftEvery(e.target.value)} className="h-8 w-20" />
                    <span className="text-muted-foreground">分钟，浮动 ±</span>
                    <Input type="number" min={0} value={draftJitter} onChange={(e) => setDraftJitter(e.target.value)} className="h-8 w-20" />
                    <span className="text-muted-foreground">分钟</span>
                  </div>
                  <textarea
                    value={draftPrompt}
                    onChange={(e) => setDraftPrompt(e.target.value)}
                    rows={6}
                    className="w-full rounded-md border border-border bg-background p-2 text-[13px] outline-none focus:border-foreground/30 resize-y"
                  />
                </>
              ) : (
                <>
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-14 shrink-0">节奏</span>
                    <span>每 {fmtDur(cron.intervalSec)}{cron.jitterSec > 0 ? `，时间浮动 ±${fmtDur(cron.jitterSec)}` : ''}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-14 shrink-0">下次</span>
                    <span className="tabular-nums">{cron.nextFire ? new Date(cron.nextFire).toLocaleString() : '—'}</span>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-1">prompt</div>
                    <div className="whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-mono text-xs text-foreground/90">{cron.prompt}</div>
                  </div>
                </>
              )}
            </div>
          </section>

          <section>
            <div className="px-1 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Runs · {runs.length}
            </div>
            {runs.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">No runs yet — fires on schedule, or hit “Run now”.</p>
            ) : (
              <ul className="space-y-1">
                {runs.map((r) => (
                  <CronRunRow key={r.id} run={r} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </ScrollArea>
    </>
  );
}

function CronRunRow({
  run,
}: {
  run: { id: string; firedAt: Date | string; status: string; output: string | null; durationMs: number | null };
}) {
  return (
    <li>
      <details className="group rounded-md border border-border">
        <summary className="cursor-pointer list-none flex items-center gap-2 px-2.5 h-9 text-[12px]">
          <CronStatusBadge status={run.status} enabled />
          <span className="tabular-nums text-muted-foreground">{relTime(run.firedAt)}</span>
          {run.durationMs != null && <span className="tabular-nums text-muted-foreground/60">{fmtMs(run.durationMs)}</span>}
          <ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="border-t border-border px-3 py-2">
          {run.output ? (
            <pre className="whitespace-pre-wrap break-words text-[11px] font-mono text-foreground/85 max-h-72 overflow-auto">{run.output}</pre>
          ) : (
            <p className="text-xs text-muted-foreground">{run.status === 'running' ? 'running…' : 'no output captured'}</p>
          )}
        </div>
      </details>
    </li>
  );
}
