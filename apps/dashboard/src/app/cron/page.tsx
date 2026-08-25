'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Clock, Play, Trash2, Pencil, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { SidebarMobileToggle } from '@/components/app-sidebar';
// Badge / run row / formatters live in cron-bits — shared with the chat pane's
// schedule cards (loop-bar) so the two render sites can't drift.
import { CronRunRow, CronStatusBadge, cronDue, fmtDur, fmtEvery } from '@/components/cron-bits';

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
  const agents = trpc.agents.list.useQuery(undefined, { staleTime: 60_000 });

  // Default landing: jump to the first cron so the pane isn't blank (mirrors /agents).
  // Skip the orchestrator (Brain) — its crons live only in /brain. Skip while the
  // "New cron" form is open.
  useEffect(() => {
    if (id || showNew) return;
    const brainName = agents.data?.find((a) => a.isOrchestrator)?.name;
    const first = (crons.data ?? []).find((c) => c.agentName !== brainName);
    if (first) router.replace(`/cron?id=${encodeURIComponent(first.id)}`);
  }, [id, showNew, crons.data, agents.data, router]);

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
          <p className="mt-1 text-xs">Create one with “New cron”, or “Schedule a task” in a chat.</p>
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
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Daily brief" className="mt-1.5 text-base sm:text-sm" />
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
          <span className="text-muted-foreground">every</span>
          <Input type="number" min={1} value={every} onChange={(e) => setEvery(e.target.value)} className="h-9 w-20" />
          <span className="text-muted-foreground">min, jitter ±</span>
          <Input type="number" min={0} value={jitter} onChange={(e) => setJitter(e.target.value)} className="h-9 w-20" />
          <span className="text-muted-foreground">min</span>
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
  const confirm = useConfirm();
  const router = useRouter();
  const q = trpc.cron.get.useQuery({ id }, { refetchInterval: 5_000 });
  // ?run=<id> deep-link (from the notifications inbox) → auto-expand that run.
  const autoRunId = useSearchParams().get('run');
  const update = trpc.cron.update.useMutation({
    onSuccess: () => { utils.cron.get.invalidate({ id }); utils.cron.list.invalidate(); setEditing(false); },
  });
  const del = trpc.cron.delete.useMutation({
    onSuccess: () => { utils.cron.list.invalidate(); router.replace('/cron'); },
  });
  const runNow = trpc.cron.runNow.useMutation({ onSuccess: () => utils.cron.get.invalidate({ id }) });
  // Reading a run = expanding it. Optimistically clear its readAt in the detail
  // cache so the red dot drops this frame; invalidate the sidebar list so its
  // roll-up dot updates. Other devices reconcile on their 5s poll.
  const markRunRead = trpc.cron.markRunRead.useMutation({
    onMutate: async ({ runId }) => {
      await utils.cron.get.cancel({ id });
      utils.cron.get.setData({ id }, (old) =>
        old ? { ...old, runs: old.runs.map((r) => (r.id === runId ? { ...r, readAt: new Date() } : r)) } : old,
      );
    },
    onSettled: () => utils.cron.list.invalidate(),
  });
  // Stable per-list callback so the memo'd CronRunRow bails across the 5s poll — an
  // inline `() => markRunRead.mutate(...)` at each row would be a fresh identity every
  // render. `.mutate` is a stable reference (React Query v5), so this useCallback is too.
  const markRead = useCallback((runId: string) => markRunRead.mutate({ runId }), [markRunRead.mutate]);
  const markAllRead = trpc.cron.markAllRead.useMutation({
    onMutate: async () => {
      await utils.cron.get.cancel({ id });
      utils.cron.get.setData({ id }, (old) =>
        old ? { ...old, runs: old.runs.map((r) => ({ ...r, readAt: r.readAt ?? new Date() })) } : old,
      );
    },
    onSettled: () => utils.cron.list.invalidate(),
  });

  const [editing, setEditing] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftEvery, setDraftEvery] = useState('');
  const [draftJitter, setDraftJitter] = useState('');

  const cron = q.data?.cron;
  const runs = q.data?.runs ?? [];
  // Unread = a finished run (ok|fail) the user hasn't expanded yet. Running runs
  // are never "unread" — they're still amber.
  const unreadRuns = runs.filter((r) => !r.readAt && r.status !== 'running').length;
  // "due" (see cronDue) drives the "下次" label + a queued hint so the UI never
  // shows a stale/past timestamp or the old 1970 epoch sentinel there.
  const queued = cronDue(cron?.nextFire);

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
              <CronStatusBadge status={cron.lastStatus} enabled={cron.enabled} done={cron.doneAt != null} />
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
            title={
              cron.enabled
                ? 'disable'
                : cron.doneAt
                  ? 'it reached its goal and stopped — switch on to start it running again'
                  : 'enable'
            }
          >
            {cron.enabled ? 'on' : 'off'}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground hover:text-rose-500"
            disabled={del.isPending}
            onClick={async () => { if (await confirm({ title: 'Delete cron', message: 'Delete this cron and its run history?', confirmLabel: 'Delete', danger: true })) del.mutate({ id }); }}
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
                    <span className="text-muted-foreground">every</span>
                    <Input type="number" min={1} value={draftEvery} onChange={(e) => setDraftEvery(e.target.value)} className="h-8 w-20" />
                    <span className="text-muted-foreground">min, jitter ±</span>
                    <Input type="number" min={0} value={draftJitter} onChange={(e) => setDraftJitter(e.target.value)} className="h-8 w-20" />
                    <span className="text-muted-foreground">min</span>
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
                    <span className="text-muted-foreground w-14 shrink-0">Every</span>
                    <span>{fmtDur(cron.intervalSec)}{cron.jitterSec > 0 ? ` ±${fmtDur(cron.jitterSec)}` : ''}</span>
                  </div>
                  {/* A cron that ended ITSELF has no next fire — it printed
                      CRON_DONE after checking its own finish line. Showing a stale
                      "Next" there reads as "still scheduled", which is the one
                      thing it is not. */}
                  {cron.doneAt ? (
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-14 shrink-0">Done</span>
                      <span className="tabular-nums">{new Date(cron.doneAt).toLocaleString()} — it reported reaching its goal</span>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-14 shrink-0">Next</span>
                      <span className="tabular-nums">{queued ? 'starting soon…' : cron.nextFire ? new Date(cron.nextFire).toLocaleString() : '—'}</span>
                    </div>
                  )}
                  {/* Where the result goes. Worth stating on the detail view: a cron
                      that reports into a conversation behaves very differently from
                      one that only files a run here, and you can't tell them apart
                      from the run list alone. */}
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-14 shrink-0">Reports</span>
                    {cron.reportSessionId ? (
                      <a
                        href={`/chat?session=${encodeURIComponent(cron.reportSessionId)}`}
                        className="text-foreground/80 underline underline-offset-2 hover:text-foreground"
                      >
                        into the chat that created it
                      </a>
                    ) : (
                      <span className="text-muted-foreground">here only</span>
                    )}
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
            <div className="px-1 pb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Runs · {runs.length}
                {unreadRuns > 0 && <span className="ml-1.5 normal-case text-rose-500">· {unreadRuns} unread</span>}
              </span>
              {unreadRuns > 0 && (
                <button
                  type="button"
                  onClick={() => markAllRead.mutate({ cronId: id })}
                  disabled={markAllRead.isPending}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  Mark all read
                </button>
              )}
            </div>
            {queued && (
              <p className="px-1 pb-1.5 text-xs text-amber-600">▶ Triggered — it starts within 15s and appears below</p>
            )}
            {runs.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">No runs yet — fires on schedule, or hit “Run now”.</p>
            ) : (
              <ul className="space-y-1">
                {runs.map((r) => (
                  <CronRunRow key={r.id} run={r} autoOpen={r.id === autoRunId} onRead={markRead} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </ScrollArea>
    </>
  );
}

