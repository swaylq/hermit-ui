'use client';

// Everything about ONE chat session, and what you can change about it from
// here: which backend runs it, and — on pi — which mode.
//
// A sheet rather than a route: the conversation stays behind it, which is the
// context you need to decide whether to move this session onto another backend.
// Mirrors the agent detail sheet so the two feel like the same idea at two
// scopes. See docs/pi-runtime-design.md.
//
// No model field. The pi model comes from Settings → Pi Runtime (the machine
// default) or the agent's own pin; a free-text model box here sat right next to
// "mode" and was read as one, while the setting that actually decides how a
// session behaves — the mode — was the read-only one.

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { CtxBar } from '@/components/ctx-bar';
import { contextWindowFor } from '@/lib/context-window';
import { BackendPicker } from './backend-picker';
import { useScope } from '@/lib/use-scope';
import {
  isRuntimeKind, runtimeLabel, toBackendOption, backendLabel,
  type RuntimeKind, type BackendOption,
} from '@/lib/runtime-labels';
import { isPiMode, piModeLabel, PI_MODE_CHOICES, PI_MODE_META, DEFAULT_PI_MODE, type PiMode } from '@/lib/pi-modes';

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 py-1.5 border-b border-border/40 last:border-0">
      <span className="w-28 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground pt-0.5">{label}</span>
      <div className={cn('min-w-0 flex-1 text-[13px] text-foreground/90 break-words', mono && 'font-mono text-xs')}>
        {children}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">{title}</h3>
      {children}
    </section>
  );
}

const DASH = <span className="text-muted-foreground/50">—</span>;

export function SessionDetailSheet({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (b: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const confirm = useConfirm();
  const scope = useScope();
  // Only polls while the sheet is open — this query carries a message count and
  // the agent lookup, which have no business riding the chat's 5s poll.
  const q = trpc.chat.sessionDetail.useQuery(
    { sessionId },
    { enabled: open, refetchInterval: open ? 10_000 : false },
  );
  const d = q.data;

  // The form holds only what the user has CHANGED; null means "whatever the
  // server says". So there is nothing to seed on load, an in-flight edit is
  // never clobbered by the 10s refetch, and a successful save snaps back to the
  // truth by clearing the override rather than by racing a re-seed.
  //
  // `stamp` is the server's answer as one string. When it moves — our save
  // landed, or another device switched this session — the override is dropped.
  // Adjusting state during render is React's own escape hatch for exactly this
  // (an effect here causes the cascading render the lint rule warns about).
  const [runtime, setRuntime] = useState<BackendOption | null>(null);
  const [mode, setMode] = useState<PiMode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [stamped, setStamped] = useState<string | null>(null);

  const stamp = d ? `${sessionId}|${d.backend.runtime}|${d.backend.runtimeMode ?? ''}` : null;
  if (stamp && stamped !== stamp) {
    setStamped(stamp);
    setRuntime(null);
    setMode(null);
    setErr(null);
  }

  // Both pickers show the RESOLVED value — they must say what is actually
  // running, not what this session happens to have written in its own columns.
  const shownBackend: BackendOption =
    runtime ?? toBackendOption(d?.backend.runtime, d?.backend.runtimeMode);
  const shownRuntime: RuntimeKind = isRuntimeKind(shownBackend) ? shownBackend : 'claude-tmux';
  // A claude session resolves to no mode at all, so when the picker is flipped
  // to pi the mode select opens on what the AGENT would start pi in — the same
  // answer "New chat" would give — rather than snapping to the fleet default.
  // The removed triage router opens on the fleet default instead of on a row
  // the select does not offer. Other unknown names pass through: a machine-local
  // mode this build does not list must keep reading as itself.
  const resolvedMode = d?.backend.runtimeMode ?? d?.agentBackend.runtimeMode ?? DEFAULT_PI_MODE;
  const currentMode = resolvedMode === 'triage' ? DEFAULT_PI_MODE : resolvedMode;
  const shownMode = mode ?? currentMode;

  const save = trpc.chat.setSessionRuntime.useMutation({
    onSuccess: () => {
      setErr(null);
      utils.chat.sessionDetail.invalidate({ sessionId });
      // The header chip and the sidebar rows read the backend too.
      utils.chat.getSession.invalidate({ sessionId });
      utils.chat.listSessions.invalidate();
    },
    onError: (e) => setErr(e.message),
  });

  // Where the mode in the picker comes from, read off the two levels the server
  // already returned rather than by re-deriving resolveRuntime's fallback chain
  // here: a session pin wins, an equal agent value means it was inherited, and
  // anything else is the resolver's default. Once a different mode is picked the
  // line stops describing the past and says what Apply is about to do.
  const modeBlurb = isPiMode(shownMode) ? PI_MODE_META[shownMode].blurb : null;
  const modeSource = shownMode !== currentMode
    ? 'Applying pins it to this session.'
    : d?.runtimeMode
      ? 'Set on this session.'
      : currentMode === d?.agentBackend.runtimeMode
        ? `Inherited from ${d.agentName}.`
        : 'The default mode.';

  const dirty = !!d
    && (shownRuntime !== d.backend.runtime
      || (shownRuntime === 'pi-rpc' && shownMode !== d.backend.runtimeMode));
  const working = d?.state === 'working';
  // A share link is scoped to one agent and deliberately gets no machine-level
  // control (the terminal is closed to it for the same reason). It can read the
  // session's state; it cannot re-point the machine's processes, and it is not
  // shown filesystem paths.
  const readOnly = scope.scoped;

  async function submit() {
    if (!d || !dirty) return;
    const changingBackend = shownRuntime !== d.backend.runtime;
    const ok = await confirm({
      title: changingBackend ? `Switch to ${backendLabel(shownBackend)}?` : `Switch mode to ${piModeLabel(shownMode)}?`,
      message: (
        <>
          The conversation on this page is kept. What is <em>not</em> kept is the running context:{' '}
          {changingBackend ? runtimeLabel(d.backend.runtime) : 'pi'} is stopped, and the next message starts a fresh
          turn on {changingBackend ? backendLabel(shownBackend) : piModeLabel(shownMode)} with no memory of this thread
          beyond what you say in it.
        </>
      ),
      confirmLabel: changingBackend ? 'Switch' : 'Switch mode',
    });
    if (!ok) return;
    save.mutate({
      id: sessionId,
      runtime: shownRuntime,
      // The session's OWN provider/model pins, not the resolved ones. Writing a
      // resolved value would turn "inherits the agent's" into a pin, and on a
      // cross-backend switch it would pin the OLD backend's. Neither is editable
      // here any more, so both simply survive a mode change untouched.
      runtimeProvider: shownRuntime === 'pi-rpc' ? d.runtimeProvider ?? null : null,
      runtimeModel: shownRuntime === 'pi-rpc' ? d.runtimeModel ?? null : null,
      // Omitted on a switch to claude, which has no modes: leaving the column
      // alone keeps the pi mode for a switch back, and the resolver already
      // reports null for anything that is not pi.
      ...(shownRuntime === 'pi-rpc' ? { runtimeMode: shownMode } : {}),
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Every width override needs the data-[side=right]: prefix. The base
          sheet sets data-[side=right]:w-3/4 AND data-[side=right]:sm:max-w-sm;
          a plain `w-full` survives tailwind-merge next to the variant class and
          then loses on specificity, which left this 292px wide on a 390px
          phone. Full-bleed below sm, capped at max-w-lg above it. */}
      <SheetContent className="data-[side=right]:w-full sm:max-w-lg data-[side=right]:sm:max-w-lg overflow-hidden flex flex-col gap-0 p-0">
        <SheetHeader className="border-b">
          <SheetTitle className="truncate">{d?.title || d?.agentName || 'Session'}</SheetTitle>
          <SheetDescription className="font-mono text-[11px]">{sessionId}</SheetDescription>
        </SheetHeader>

        {q.isPending && (
          <div className="p-6 space-y-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-32" />
          </div>
        )}

        {q.data === null && (
          <div className="p-6 text-sm text-muted-foreground">This session no longer exists.</div>
        )}

        {d && (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
            <Section title="backend">
              <BackendPicker
                value={shownBackend}
                onChange={(v) => { setRuntime(v); setErr(null); }}
                disabled={readOnly || working || save.isPending}
                agentDefault={toBackendOption(d.agentBackend.runtime, d.agentBackend.runtimeMode)}
              />

              {/* Which mode this session runs — the setting that decides the
                  most: the mode names the ENGINE (pi or omp), the system prompt,
                  the tool list and the skills. It used to be read-only here
                  ("change it by starting a new chat"), which meant the one
                  setting worth changing was the one you couldn't. Keyed off the
                  PICKER's runtime, not the server's, so flipping to pi offers
                  its mode in the same breath and one Apply lands both. */}
              {shownBackend === 'pi-rpc' && (
                <label className="mt-2.5 block">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">mode</span>
                  <Select
                    value={shownMode}
                    onValueChange={(v) => { setMode(isPiMode(v) ? v : DEFAULT_PI_MODE); setErr(null); }}
                    disabled={readOnly || working || save.isPending}
                    modal={false}
                  >
                    <SelectTrigger aria-label="pi mode" className="mt-1 w-full py-1.5 text-sm">
                      {/* piModeLabel falls back to the raw directory name, so a
                          machine-local mode this build doesn't list still reads
                          as itself rather than as the default. */}
                      <SelectValue>{(v: string | null) => piModeLabel(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {PI_MODE_CHOICES.map((m) => <SelectItem key={m} value={m}>{PI_MODE_META[m].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                    {modeBlurb ? `${modeBlurb} ` : ''}
                    {modeSource}
                  </span>
                </label>
              )}

              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                {d.inherited ? (
                  <>Inherited from <span className="font-mono">{d.agentName}</span> ({runtimeLabel(d.agentBackend.runtime)}). Choosing here pins it to this session.</>
                ) : (
                  <>Set on this session. The agent&apos;s own default is {runtimeLabel(d.agentBackend.runtime)}.</>
                )}
              </p>

              {working && (
                <p className="mt-2 text-[11px] text-amber-500">
                  Mid-turn — the switch is disabled until this turn finishes.
                </p>
              )}
              {err && <p className="mt-2 text-[11px] text-rose-500">{err}</p>}

              <div className={cn('mt-2.5 flex items-center gap-2', readOnly && 'hidden')}>
                <Button
                  size="sm"
                  className="h-8"
                  disabled={!dirty || working || save.isPending}
                  onClick={submit}
                >
                  {save.isPending ? 'switching…' : 'Apply'}
                </Button>
                {dirty && !save.isPending && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    onClick={() => { setRuntime(null); setMode(null); setErr(null); }}
                  >
                    reset
                  </Button>
                )}
                {save.data?.restarted && !dirty && (
                  <span className="text-[11px] text-muted-foreground">
                    stopped — the next message starts it on {runtimeLabel(d.backend.runtime)}
                    {d.backend.runtime === 'pi-rpc' && ` · ${piModeLabel(d.backend.runtimeMode)}`}
                  </span>
                )}
              </div>
            </Section>

            <Section title="run">
              <Row label="state">
                <span className="font-mono text-xs">{d.state ?? 'idle'}</span>
                {d.hibernatedAt && <span className="ml-2 text-xs text-muted-foreground">💤 asleep since {relTime(d.hibernatedAt)}</span>}
              </Row>
              <Row label="context"><CtxBar tokens={d.contextTokens} total={contextWindowFor(d.backend.runtime, d.backend.runtimeModel)} /></Row>
              <Row label="process" mono>
                {d.alive ? `alive${d.pid ? ` · pid ${d.pid}` : ''}${d.rssMb ? ` · ${d.rssMb} MB` : ''}` : 'not running'}
              </Row>
              <Row label="snapshot">{d.snapshotAt ? relTime(d.snapshotAt) : DASH}</Row>
              <Row label="last activity">{d.lastActivity ? relTime(d.lastActivity) : DASH}</Row>
            </Section>

            <Section title="conversation">
              <Row label="messages" mono>{d.messageCount}</Row>
              <Row label="started">{relTime(d.startedAt)}</Row>
              <Row label="last message">{d.lastMessageAt ? relTime(d.lastMessageAt) : DASH}</Row>
              <Row label="title">{d.title ? `${d.title}${d.titleAuto ? ' (auto)' : ''}` : DASH}</Row>
              <Row label="group">{d.groupName ?? DASH}</Row>
              <Row label="flags">
                {[d.closedAt && 'closed', d.hiddenAt && 'hidden', d.origin && `origin:${d.origin}`]
                  .filter(Boolean)
                  .join(' · ') || DASH}
              </Row>
            </Section>

            <Section title="where">
              <Row label="agent">
                <Link
                  href={`/agents?name=${encodeURIComponent(d.agentName)}`}
                  className="font-mono text-xs hover:underline underline-offset-2"
                >
                  {d.agentName}
                </Link>
              </Row>
              {/* Filesystem paths and the backend's own session id are machine
                  internals — not for a share link, which only ever gets one
                  agent's conversation. */}
              {!readOnly && (
                <>
                  <Row label="directory" mono>{d.agentDirectory ?? DASH}</Row>
                  <Row label="backend id" mono>{d.claudeSessionId ?? DASH}</Row>
                  <Row label="transcript" mono>{d.transcriptPath ?? DASH}</Row>
                </>
              )}
            </Section>
          </div>
        )}

        {q.error && <div className="p-6 text-sm text-rose-400">error: {q.error.message}</div>}
      </SheetContent>
    </Sheet>
  );
}
