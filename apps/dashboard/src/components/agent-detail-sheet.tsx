'use client';

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { fmtBytes, ctxPct, relTime, stateColor } from '@/lib/format';
import { SystemTasksSection } from './system-tasks-section';

type AgentByNameOutput = NonNullable<inferRouterOutputs<AppRouter>['agents']['byName']>;
type SessionRow = inferRouterOutputs<AppRouter>['chat']['listSessions'][number];

export function AgentDetailSheet({
  open,
  onOpenChange,
  name,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  name: string | null;
}) {
  const query = trpc.agents.byName.useQuery(
    { name: name ?? '' },
    { enabled: !!name && open, refetchInterval: open ? 5000 : false },
  );
  // Restart-per-session UX (was restart-per-agent before): list every chat
  // session targeting this agent, each with its own restart button.
  const sessions = trpc.chat.listSessions.useQuery(
    { agentName: name ?? '' },
    { enabled: !!name && open, refetchInterval: open ? 5000 : false },
  );

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-xl overflow-hidden flex flex-col gap-0 p-0">
          <SheetHeader className="border-b">
            <div className="min-w-0">
              <SheetTitle className="font-mono">{name ?? '—'}</SheetTitle>
              <SheetDescription>
                {query.data?.agent.alive ? 'live process · refresh 5s' : 'pid no longer alive'}
              </SheetDescription>
            </div>
          </SheetHeader>

          {query.isPending && (
            <div className="p-6 space-y-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-32" />
              <Skeleton className="h-48" />
            </div>
          )}

          {query.data && name && (
            <ScrollArea className="flex-1">
              <div className="p-6 space-y-5">
                <AgentMeta data={query.data} />

                <SessionsSection agentName={name} sessions={sessions.data ?? null} loading={sessions.isPending} />

                <SystemTasksSection agentName={name} />

                {query.data.lastUserPrompt && (
                  <section>
                    <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">last user prompt</h3>
                    <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                      {query.data.lastUserPrompt}
                    </p>
                  </section>
                )}

                {query.data.lastAssistantText && (
                  <section>
                    <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">last agent reply</h3>
                    <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                      {query.data.lastAssistantText}
                    </p>
                  </section>
                )}

                <section>
                  <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                    recent events · {query.data.events.length}
                  </h3>
                  <div className="space-y-2">
                    {query.data.events.length === 0 ? (
                      <p className="text-xs text-muted-foreground">no events for this agent yet.</p>
                    ) : (
                      query.data.events.map((e) => (
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
              </div>
            </ScrollArea>
          )}

          {query.error && (
            <div className="p-6 text-sm text-rose-400">error: {query.error.message}</div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

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
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : !sessions || sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground">no chat sessions for this agent yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {sessions.map((s) => {
            const pending = !!s.restartRequestedAt;
            const disabled = !!s.closedAt || pending || requestRestart.isPending;
            return (
              <li key={s.id} className="flex items-center gap-2 rounded border bg-card px-2.5 py-1.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="truncate text-foreground/90">{s.title || s.id.slice(0, 8)}</span>
                    {s.closedAt && (
                      <Badge variant="outline" className="text-[9px] py-0 h-4">closed</Badge>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground tabular-nums">
                    {s._count.messages} msg · last {relTime(s.lastMessageAt ?? s.startedAt)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs px-2"
                  disabled={disabled}
                  onClick={() => requestRestart.mutate({ id: s.id })}
                  title={
                    s.closedAt
                      ? 'session is closed'
                      : pending
                        ? 'restart already requested — gateway will pick it up'
                        : 'kill this session\'s tmux pane; next message respawns with --resume'
                  }
                >
                  {pending ? 'queued…' : requestRestart.isPending ? 'sending…' : 'restart'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AgentMeta({ data }: { data: AgentByNameOutput }) {
  const a = data.agent;
  const c = stateColor(a.state, a.alive);
  const pct = ctxPct(a.contextTokens);
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${c.dot}`} />
        <Badge variant="outline" className={`${c.text} ${c.border} font-mono`}>
          {a.alive ? a.state ?? 'unknown' : 'down'}
        </Badge>
        <span className="text-xs text-muted-foreground font-mono">pid {a.pid ?? '-'}</span>
        <span className="text-xs text-muted-foreground font-mono">last {relTime(a.lastActivity)}</span>
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">context</span>
          <span className="font-mono">
            <span className="text-foreground">{fmtBytes(a.contextTokens)}</span>
            <span className="text-muted-foreground"> / 1M ({pct.toFixed(1)}%)</span>
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded bg-zinc-800">
          <div
            className={`h-full transition-all ${pct >= 80 ? 'bg-rose-500' : pct >= 50 ? 'bg-amber-400' : 'bg-emerald-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <Separator />

      <dl className="text-xs font-mono grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        <dt>transcript</dt>
        <dd className="break-all text-foreground/80">{a.transcriptPath ?? '-'}</dd>
        <dt>output tokens</dt>
        <dd className="text-foreground">{fmtBytes(a.outputTokens)}</dd>
        <dt>updated</dt>
        <dd className="text-foreground">{relTime(a.updatedAt)}</dd>
      </dl>
    </section>
  );
}
