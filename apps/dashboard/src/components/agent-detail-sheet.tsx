'use client';

import { useState } from 'react';
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
import { SystemTasksSection } from './system-tasks-section';

type SessionRow = inferRouterOutputs<AppRouter>['chat']['listSessions'][number];
type AgentByNameOutput = NonNullable<inferRouterOutputs<AppRouter>['agents']['byName']>;

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
      <SheetContent className="w-full sm:max-w-xl overflow-hidden flex flex-col gap-0 p-0">
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
          <ScrollArea className="flex-1">
            <div className="p-6 space-y-5">
              <SessionsSection agentName={name} sessions={sessions.data ?? null} loading={sessions.isPending} />

              <SkillsAndTasks agent={query.data.agent} agentName={name} />

              <MarkdownSections agent={query.data.agent} />

              <EventsSection data={query.data} />
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
            return (
              <li key={s.id} className="rounded border bg-card px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full shrink-0',
                      s.alive ? 'bg-emerald-500' : 'bg-zinc-500',
                    )}
                    aria-hidden="true"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="truncate text-foreground/90">{s.title || s.id.slice(0, 8)}</span>
                      {s.closedAt && (
                        <Badge variant="outline" className="text-[9px] py-0 h-4">closed</Badge>
                      )}
                      {s.alive && s.state && (
                        <Badge variant="outline" className="text-[9px] py-0 h-4 font-mono">{s.state}</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground tabular-nums mt-0.5">
                      <span>{s._count.messages} msg</span>
                      <span className="text-muted-foreground/40">·</span>
                      <span>last {relTime(s.lastMessageAt ?? s.startedAt)}</span>
                      {s.contextTokens != null && (
                        <>
                          <span className="text-muted-foreground/40">·</span>
                          <CtxBar tokens={s.contextTokens} />
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs px-2 shrink-0"
                    disabled={disabled}
                    onClick={() => requestRestart.mutate({ id: s.id })}
                    title={
                      s.closedAt
                        ? 'session is closed'
                        : pending
                          ? 'restart already requested — gateway will pick it up'
                          : "kill this session's tmux pane; next message respawns with --resume"
                    }
                  >
                    {pending ? 'queued…' : requestRestart.isPending ? '…' : 'restart'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Skills + scheduled tasks ────────────────────────────────────────────────

function SkillsAndTasks({ agent, agentName }: { agent: AgentByNameOutput['agent']; agentName: string }) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
          skills · {agent.skillNames.length}
        </h3>
        {agent.skillNames.length === 0 ? (
          <p className="text-xs text-muted-foreground">no skills installed under <code className="font-mono">.claude/skills/</code>.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {agent.skillNames.map((s) => (
              <Badge key={s} variant="outline" className="font-mono text-[11px]">{s}</Badge>
            ))}
          </div>
        )}
      </div>

      <SystemTasksSection agentName={agentName} />
    </section>
  );
}

// ── Identity / User / Workspace / Tools / Evolution (collapsible) ───────────

function MarkdownSections({ agent }: { agent: AgentByNameOutput['agent'] }) {
  const blocks: Array<{ label: string; text: string | null; defaultOpen?: boolean }> = [
    { label: 'Identity', text: agent.identityText, defaultOpen: true },
    { label: 'User', text: agent.userText },
    { label: 'Workspace rules', text: agent.agentsText },
    { label: 'Tools', text: agent.toolsText },
    { label: 'Evolution', text: agent.evolutionLessons },
  ];
  if (agent.memorySummary) {
    blocks.push({ label: 'Memory', text: agent.memorySummary });
  }
  return (
    <section className="space-y-2">
      {blocks.map((b) => (
        <CollapsibleBlock key={b.label} label={b.label} body={b.text} defaultOpen={b.defaultOpen} />
      ))}
    </section>
  );
}

function CollapsibleBlock({ label, body, defaultOpen = false }: { label: string; body: string | null; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!body) {
    return (
      <div className="text-xs text-muted-foreground/70 px-3 py-2 rounded border border-dashed">
        <span className="uppercase tracking-wide">{label}</span> <span className="text-muted-foreground/50">— not present</span>
      </div>
    );
  }
  return (
    <div className="rounded border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
      >
        <span>{label}</span>
        <span className="text-muted-foreground/60 font-mono">{open ? '−' : '+'} {body.length.toLocaleString()}c</span>
      </button>
      {open && (
        <div className="border-t px-3 py-2 text-sm">
          <Markdown>{body}</Markdown>
        </div>
      )}
    </div>
  );
}

// ── Recent events ────────────────────────────────────────────────────────────

function EventsSection({ data }: { data: AgentByNameOutput }) {
  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
        recent events · {data.events.length}
      </h3>
      <div className="space-y-2">
        {data.events.length === 0 ? (
          <p className="text-xs text-muted-foreground">no events for this agent yet.</p>
        ) : (
          data.events.map((e) => (
            <div key={e.id} className="rounded border bg-card p-2 space-y-1">
              <div className="flex items-center justify-between text-xs">
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {e.type}
                </Badge>
                <span className="text-muted-foreground font-mono">{relTime(e.ts)}</span>
              </div>
              {e.title && <p className="text-xs text-muted-foreground">{e.title}</p>}
              <pre className="text-xs font-mono whitespace-pre-wrap text-foreground">{e.message}</pre>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
