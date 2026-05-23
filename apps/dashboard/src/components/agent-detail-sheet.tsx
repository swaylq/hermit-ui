'use client';

import { useState } from 'react';
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
  const utils = trpc.useUtils();
  const requestRestart = trpc.agents.requestRestart.useMutation({
    onSuccess: () => {
      utils.agents.byName.invalidate({ name: name ?? '' });
      utils.agents.list.invalidate();
    },
  });
  const restartState = query.data?.agent.restartStartedAt
    ? 'running'
    : query.data?.agent.restartRequestedAt
      ? 'queued'
      : null;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-xl overflow-hidden flex flex-col gap-0 p-0">
          <SheetHeader className="border-b">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <SheetTitle className="font-mono">{name ?? '—'}</SheetTitle>
                <SheetDescription>
                  {query.data?.agent.alive ? 'live process · refresh 5s' : 'pid no longer alive'}
                </SheetDescription>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={!name || requestRestart.isPending || restartState != null}
                onClick={() => name && requestRestart.mutate({ name })}
              >
                {restartState === 'running'
                  ? 'restarting…'
                  : restartState === 'queued'
                    ? 'queued'
                    : requestRestart.isPending
                      ? 'sending…'
                      : 'restart'}
              </Button>
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
