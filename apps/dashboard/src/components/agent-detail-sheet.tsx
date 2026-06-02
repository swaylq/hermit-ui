'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Pencil, Check, X, RotateCw } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Markdown } from './markdown';
import { CtxBar } from './ctx-bar';
import { sessionStatusView } from '@/lib/session-status';
import { useUnread } from '@/lib/session-read';

type SessionRow = inferRouterOutputs<AppRouter>['chat']['listSessions'][number];
type AgentByNameOutput = NonNullable<inferRouterOutputs<AppRouter>['agents']['byName']>;

// AgentDetailBody — renders the agent detail panel without a Sheet wrapper.
// Used by the inline /agents page (which lays the detail out side-by-side
// with the sidebar, no modal needed). Owns its own queries so callers just
// pass `name` and get a rendered detail block.
export function AgentDetailBody({ name }: { name: string }) {
  const query = trpc.agents.byName.useQuery({ name }, { refetchInterval: 30_000 });
  const sessions = trpc.chat.listSessions.useQuery({ agentName: name }, { refetchInterval: 5_000 });

  if (query.isPending) {
    return (
      <div className="p-4 sm:p-6 space-y-3">
        <Skeleton className="h-12" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (query.error) {
    return <div className="p-4 sm:p-6 text-sm text-rose-400">error: {query.error.message}</div>;
  }
  if (!query.data) {
    return <div className="p-4 sm:p-6 text-sm text-muted-foreground">agent not found.</div>;
  }
  return (
    <div className="p-4 sm:p-6 space-y-5">
      <SessionsSection agentName={name} sessions={sessions.data ?? null} loading={sessions.isPending} />
      <CronsSection agentName={name} />
      <SkillsAndTasks agent={query.data.agent} agentName={name} />
      <MarkdownSections agent={query.data.agent} agentName={name} />
    </div>
  );
}

export function AgentDetailSheet({
  open,
  onOpenChange,
  name,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  name: string | null;
}) {
  // metadataAt only updates every ~5min on the gateway side, so 30s refetch
  // on the dashboard is plenty (mostly we're catching agent rename / new
  // skill folder).
  const query = trpc.agents.byName.useQuery(
    { name: name ?? '' },
    { enabled: !!name && open, refetchInterval: open ? 30_000 : false },
  );
  const sessions = trpc.chat.listSessions.useQuery(
    { agentName: name ?? '' },
    { enabled: !!name && open, refetchInterval: open ? 5_000 : false },
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* data-[side=right]: prefix is required: the base sheet sets
          data-[side=right]:sm:max-w-sm, which tailwind-merge keeps alongside a
          plain sm:max-w-* override and then wins on specificity. Match the
          variant so the wider cap actually takes effect. */}
      <SheetContent className="w-full sm:max-w-2xl data-[side=right]:sm:max-w-2xl overflow-hidden flex flex-col gap-0 p-0">
        <SheetHeader className="border-b">
          <div className="min-w-0">
            <SheetTitle className="font-mono">{name ?? '—'}</SheetTitle>
            <SheetDescription>
              {query.data?.agent.directory ? (
                <span className="font-mono text-[11px] truncate block">{query.data.agent.directory}</span>
              ) : (
                'agent workspace'
              )}
            </SheetDescription>
          </div>
        </SheetHeader>

        {query.isPending && (
          <div className="p-6 space-y-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        )}

        {query.data && name && (
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-6 space-y-5">
              <SessionsSection agentName={name} sessions={sessions.data ?? null} loading={sessions.isPending} />

              <CronsSection agentName={name} />

              <SkillsAndTasks agent={query.data.agent} agentName={name} />

              <MarkdownSections agent={query.data.agent} agentName={name} />
            </div>
          </ScrollArea>
        )}

        {query.error && (
          <div className="p-6 text-sm text-rose-400">error: {query.error.message}</div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Sessions list (each with its own runtime info) ───────────────────────────

function SessionsSection({
  agentName,
  sessions,
  loading,
}: {
  agentName: string;
  sessions: SessionRow[] | null;
  loading: boolean;
}) {
  const utils = trpc.useUtils();
  const requestRestart = trpc.chat.requestSessionRestart.useMutation({
    onSuccess: () => {
      utils.chat.listSessions.invalidate({ agentName });
    },
  });
  const isUnread = useUnread();

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
        sessions · {sessions?.length ?? 0}
      </h3>
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : !sessions || sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground">no chat sessions for this agent yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {sessions.map((s) => {
            const pending = !!s.restartRequestedAt;
            const disabled = !!s.closedAt || pending || requestRestart.isPending;
            const status = sessionStatusView(s, { unread: isUnread(s.id, s.lastMessageAt) });
            return (
              <li key={s.id}>
                <Link
                  href={`/chat?session=${encodeURIComponent(s.id)}`}
                  className="block rounded border bg-card px-2.5 py-1.5 hover:bg-accent/40 hover:border-foreground/30 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn('h-1.5 w-1.5 rounded-full shrink-0', status.dot, status.pulse && 'animate-pulse')}
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="truncate text-foreground/90">{s.title || s.preview || s.agentName || s.id.slice(0, 8)}</span>
                        {s.closedAt && (
                          <Badge variant="outline" className="text-[9px] py-0 h-4">closed</Badge>
                        )}
                        {status.key !== 'ready' && (
                          <Badge variant="outline" className="text-[9px] py-0 h-4 font-mono">{status.label}</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground tabular-nums mt-0.5">
                        <span>last {relTime(s.lastMessageAt ?? s.startedAt)}</span>
                        <span className="text-muted-foreground/40">·</span>
                        <CtxBar tokens={s.contextTokens} />
                      </div>
                    </div>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      disabled={disabled}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        requestRestart.mutate({ id: s.id });
                      }}
                      aria-label="restart session"
                      title={
                        s.closedAt
                          ? 'session is closed'
                          : pending
                            ? 'restart already requested — gateway will pick it up'
                            : "restart — kill this session's tmux pane; next message respawns with --resume"
                      }
                    >
                      <RotateCw className={cn('size-3.5', (pending || requestRestart.isPending) && 'animate-spin')} />
                    </Button>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Scheduled tasks (cron) ──────────────────────────────────────────────────

// Compact human duration for the cadence line: 3600→"1h", 300→"5m", 90→"90s".
function fmtDur(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

function CronsSection({ agentName }: { agentName: string }) {
  const crons = trpc.cron.listForAgent.useQuery({ agentName }, { refetchInterval: 10_000 });
  const list = crons.data ?? [];

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
        scheduled · {list.length}
      </h3>
      {crons.isPending ? (
        <Skeleton className="h-10" />
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          no scheduled tasks. create one with “开启定时任务” in a chat.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((c) => {
            const dot = !c.enabled
              ? 'bg-zinc-500'
              : c.lastStatus === 'fail'
                ? 'bg-rose-500'
                : c.lastStatus === 'running'
                  ? 'bg-amber-500'
                  : c.lastStatus === 'ok'
                    ? 'bg-emerald-500'
                    : 'bg-zinc-400';
            const running = c.enabled && c.lastStatus === 'running';
            return (
              <li key={c.id}>
                <Link
                  href={`/cron?id=${encodeURIComponent(c.id)}`}
                  className="block rounded border bg-card px-2.5 py-1.5 hover:bg-accent/40 hover:border-foreground/30 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn('h-1.5 w-1.5 rounded-full shrink-0', dot, running && 'animate-pulse')}
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="truncate text-foreground/90">{c.title || c.prompt}</span>
                        {!c.enabled && (
                          <Badge variant="outline" className="text-[9px] py-0 h-4">off</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground tabular-nums mt-0.5">
                        <span>every {fmtDur(c.intervalSec)}{c.jitterSec > 0 ? ` ±${fmtDur(c.jitterSec)}` : ''}</span>
                        <span className="text-muted-foreground/40">·</span>
                        <span>{c.lastFire ? `last ${relTime(c.lastFire)}` : 'never run'}</span>
                      </div>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Skills ──────────────────────────────────────────────────────────────────

function SkillsAndTasks({ agent, agentName }: { agent: AgentByNameOutput['agent']; agentName: string }) {
  // Per-skill SKILL.md contents come down on the agent sync (Agent.skills Json).
  // Falls back to a chip-only list if the gateway hasn't synced contents yet.
  const skills = ((agent as unknown as { skills?: Array<{ name: string; content: string }> }).skills) ?? [];
  const hasContent = skills.length > 0;
  return (
    <section className="space-y-4">
      <div className="space-y-1.5">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
          skills · {agent.skillNames.length}
        </h3>
        {agent.skillNames.length === 0 ? (
          <p className="text-xs text-muted-foreground">no skills installed under <code className="font-mono">.claude/skills/</code>.</p>
        ) : hasContent ? (
          <div className="space-y-1.5">
            {agent.skillNames.map((name) => {
              const body = skills.find((s) => s.name === name)?.content ?? '';
              return (
                <CollapsibleBlock
                  key={name}
                  label={name}
                  body={body}
                  agentName={agentName}
                  target={`skill:${name}`}
                  monoLabel
                />
              );
            })}
          </div>
        ) : (
          // Pre-sync fallback: chip-only list (no contents yet to view/edit).
          <div className="flex flex-wrap gap-1.5">
            {agent.skillNames.map((s) => (
              <Badge key={s} variant="outline" className="font-mono text-[11px]">{s}</Badge>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Identity / User / Workspace / Tools / Evolution (collapsible) ───────────

function MarkdownSections({ agent, agentName }: { agent: AgentByNameOutput['agent']; agentName: string }) {
  const blocks: Array<{ label: string; text: string | null; target: string; defaultOpen?: boolean }> = [
    { label: 'Identity', text: agent.identityText, target: 'identity', defaultOpen: true },
    { label: 'User', text: agent.userText, target: 'user' },
    { label: 'Workspace rules', text: agent.agentsText, target: 'agents' },
    { label: 'Tools', text: agent.toolsText, target: 'tools' },
    { label: 'Evolution', text: agent.evolutionLessons, target: 'evolution' },
  ];
  return (
    <section className="space-y-2">
      {blocks.map((b) => (
        <CollapsibleBlock
          key={b.label}
          label={b.label}
          body={b.text}
          defaultOpen={b.defaultOpen}
          agentName={agentName}
          target={b.target}
        />
      ))}
      {/* Memory is an auto-generated listing, not one file — read-only. */}
      {agent.memorySummary && <CollapsibleBlock label="Memory" body={agent.memorySummary} />}
    </section>
  );
}

function CollapsibleBlock({
  label,
  body,
  defaultOpen = false,
  agentName,
  target,
  monoLabel = false,
}: {
  label: string;
  body: string | null;
  defaultOpen?: boolean;
  // When both agentName and target are given, the block becomes editable
  // (Pencil → textarea → Save queues an AgentRequest the gateway writes).
  agentName?: string;
  target?: string;
  monoLabel?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const utils = trpc.useUtils();
  const editable = !!agentName && !!target;

  const save = trpc.agents.requestEdit.useMutation({
    onSuccess: () => {
      if (agentName) utils.agents.byName.invalidate({ name: agentName });
      setEditing(false);
    },
  });
  const pending = trpc.agents.pendingRequests.useQuery(undefined, {
    enabled: editable,
    refetchInterval: editable ? 2_000 : false,
  });
  const isSaving = editable && (pending.data ?? []).some(
    (p) => p.kind === 'edit' && p.agentName === agentName && p.target === target,
  );

  if (!body) {
    return (
      <div className="text-xs text-muted-foreground/70 px-3 py-2 rounded border border-dashed">
        <span className={cn('uppercase tracking-wide', monoLabel && 'normal-case tracking-normal font-mono text-foreground/80')}>{label}</span>
        <span className="text-muted-foreground/50"> — not present</span>
      </div>
    );
  }
  return (
    <div className="rounded border bg-card">
      <div className="w-full flex items-center justify-between px-3 py-2 gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 text-left flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <span className={cn('truncate', monoLabel && 'normal-case tracking-normal font-mono text-foreground/85 text-[12px]')}>{label}</span>
          {isSaving && <span className="text-[10px] text-muted-foreground animate-pulse normal-case tracking-normal">saving…</span>}
        </button>
        <div className="flex items-center gap-1.5 shrink-0">
          {open && editable && !editing && (
            <button
              type="button"
              onClick={() => { setDraft(body); setEditing(true); }}
              title={`edit ${label}`}
              aria-label={`edit ${label}`}
              className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-muted-foreground/60 font-mono text-xs hover:text-foreground transition-colors cursor-pointer"
            aria-label={open ? 'collapse' : 'expand'}
          >
            {open ? '−' : '+'} {body.length.toLocaleString()}c
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t px-3 py-2 text-sm">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(28, Math.max(8, draft.split('\n').length + 1))}
                className="w-full font-mono text-[12px] leading-relaxed bg-background border border-border rounded-md px-2 py-1.5 outline-none focus:border-foreground/30 resize-y"
              />
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => agentName && target && save.mutate({ name: agentName, target, content: draft })}
                  disabled={save.isPending || draft === body}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs font-medium bg-foreground text-background hover:bg-foreground/90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Check className="h-3.5 w-3.5" /> {save.isPending ? 'queuing…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setDraft(''); }}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs text-muted-foreground hover:bg-accent cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" /> cancel
                </button>
                {save.error && <span className="text-[11px] text-rose-500">{save.error.message}</span>}
                {!save.error && save.isSuccess && <span className="text-[11px] text-muted-foreground">queued — gateway writes the file then re-syncs.</span>}
              </div>
            </div>
          ) : (
            <Markdown>{body}</Markdown>
          )}
        </div>
      )}
    </div>
  );
}

