'use client';

// Everything about ONE chat session, and what you can change about it from
// here: which backend runs it, and — on pi — which mode.
//
// A sheet rather than a route: the conversation stays behind it, which is the
// context you need to decide whether to move this session onto another backend.
// Mirrors the agent detail sheet so the two feel like the same idea at two
// scopes. See docs/pi-runtime-design.md.
//
// No EDITABLE model field. The pi model comes from Settings → Pi Runtime (the
// machine default) or the agent's own pin; a free-text model box here sat right
// next to "mode" and was read as one, while the setting that actually decides
// how a session behaves — the mode — was the read-only one. A Claude Code
// session does show which model it runs, because that one is switchable now —
// from the chip in the chat header, which is the only control (chat/model-chip.tsx).

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
  runtimeLabel, sharesConversation,
} from '@/lib/runtime-labels';
import { availableBackends, backendById, DEFAULT_BACKEND_ID } from '@/lib/backends';
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

  // The same query (and staleTime) the picker inside this sheet runs, so
  // react-query serves both from one request. Read here as well because the
  // sheet has to know which HARNESS the chosen backend runs before it can decide
  // whether a Mode select belongs on screen.
  const cfg = trpc.machines.getBackendsConfig.useQuery(undefined, { staleTime: 60_000 });


  // The form holds only what the user has CHANGED; null means "whatever the
  // server says". So there is nothing to seed on load, an in-flight edit is
  // never clobbered by the 10s refetch, and a successful save snaps back to the
  // truth by clearing the override rather than by racing a re-seed.
  //
  // `stamp` is the server's answer as one string. When it moves — our save
  // landed, or another device switched this session — the override is dropped.
  // Adjusting state during render is React's own escape hatch for exactly this
  // (an effect here causes the cascading render the lint rule warns about).
  const [runtime, setRuntime] = useState<string | null>(null);
  const [mode, setMode] = useState<PiMode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [stamped, setStamped] = useState<string | null>(null);

  const stamp = d ? `${sessionId}|${d.backend.backendId}|${d.backend.runtimeMode ?? ''}` : null;
  if (stamp && stamped !== stamp) {
    setStamped(stamp);
    setRuntime(null);
    setMode(null);
    setErr(null);
  }

  // Both pickers show the RESOLVED value — they must say what is actually
  // running, not what this session happens to have written in its own columns.
  // The last fallback is the resolver's own floor, not the pane: reaching it
  // means the detail query has not answered yet, and naming a backend the
  // session is not on would be the one thing these pickers must never do.
  const shownBackend: string = runtime ?? d?.backend.backendId ?? DEFAULT_BACKEND_ID;
  // The mode select follows the HARNESS behind the chosen backend, not its
  // name: two backends can both run pi against different credentials.
  const shownIsPi = backendById(cfg.data, shownBackend)?.harness === 'pi-rpc';
  const backendLabelOf = (id: string) =>
    availableBackends(cfg.data, id).find((b) => b.id === id)?.label ?? runtimeLabel(id);
  // A backend id is not a harness — a composed one has an id of its own — and
  // it is the HARNESS that decides whether a switch keeps the conversation.
  const harnessOfBackend = (id: string) => backendById(cfg.data, id)?.harness ?? id;
  // Which driver AND whose endpoint — both halves decide whether the transcript
  // survives the move. See sharesConversation.
  const sideOfBackend = (id: string) => ({
    runtime: harnessOfBackend(id),
    credentialId: backendById(cfg.data, id)?.credentialId ?? null,
  });
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
    && (shownBackend !== d.backend.backendId
      || (shownIsPi && shownMode !== d.backend.runtimeMode));
  const working = d?.state === 'working';
  // A share link is scoped to one agent and deliberately gets no machine-level
  // control (the terminal is closed to it for the same reason). It can read the
  // session's state; it cannot re-point the machine's processes, and it is not
  // shown filesystem paths.
  const readOnly = scope.scoped;

  async function submit() {
    if (!d || !dirty) return;
    const changingBackend = shownBackend !== d.backend.backendId;
    // The two Claude Code drivers write the same transcript, so moving between
    // them resumes it rather than abandoning it — the running context comes
    // along. Saying otherwise would talk a user out of a move that costs
    // nothing, which is the opposite of what this dialog is for.
    const keepsContext = changingBackend && sharesConversation(
      { runtime: d.backend.runtime, credentialId: d.backend.runtimeCredentialId },
      sideOfBackend(shownBackend),
    );
    const ok = await confirm({
      title: changingBackend ? `Switch to ${backendLabelOf(shownBackend)}?` : `Switch mode to ${piModeLabel(shownMode)}?`,
      message: keepsContext ? (
        <>
          Both are Claude Code on the same conversation, so nothing is lost:{' '}
          {backendLabelOf(d.backend.backendId)} is stopped and{' '}
          {backendLabelOf(shownBackend)} resumes the same transcript, with its full history, on the
          next message.
        </>
      ) : (
        <>
          The conversation on this page is kept. What is <em>not</em> kept is the running context:{' '}
          {changingBackend ? backendLabelOf(d.backend.backendId) : 'pi'} is stopped, and the next message starts a fresh
          turn on {changingBackend ? backendLabelOf(shownBackend) : piModeLabel(shownMode)} with no memory of this thread
          beyond what you say in it.
        </>
      ),
      confirmLabel: changingBackend ? 'Switch' : 'Switch mode',
    });
    if (!ok) return;
    save.mutate({
      id: sessionId,
      runtime: shownBackend,
      // The session's OWN provider/model pins, not the resolved ones. Writing a
      // resolved value would turn "inherits the agent's" into a pin, and on a
      // cross-backend switch it would pin the OLD backend's. Neither is editable
      // here any more, so both simply survive a mode change untouched.
      runtimeProvider: shownIsPi ? d.runtimeProvider ?? null : null,
      runtimeModel: shownIsPi ? d.runtimeModel ?? null : null,
      // Omitted on a switch to claude, which has no modes: leaving the column
      // alone keeps the pi mode for a switch back, and the resolver already
      // reports null for anything that is not pi.
      ...(shownIsPi ? { runtimeMode: shownMode } : {}),
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
                agentDefault={d.agentBackend.backendId}
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
                  <>Inherited from <span className="font-mono">{d.agentName}</span> ({backendLabelOf(d.agentBackend.backendId)}). Choosing here pins it to this session.</>
                ) : (
                  <>Set on this session. The agent&apos;s own default is {backendLabelOf(d.agentBackend.backendId)}.</>
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
                    stopped — the next message starts it on {backendLabelOf(d.backend.backendId)}
                    {d.backend.runtime === 'pi-rpc' && ` · ${piModeLabel(d.backend.runtimeMode)}`}
                  </span>
                )}
              </div>
            </Section>

            <Section title="run">
              {/* Reported, not edited. The switch itself is the chip in the chat
                  header, one click from the reply that made you want it — and
                  keeping the only control in one place is what stops this sheet
                  from growing a second, disagreeing answer. */}
              {d.backend.runtime === 'claude-sdk' && (
                <Row label="model" mono>
                  {d.backend.runtimeModel ?? 'default'}
                  <span className="ml-2 font-sans text-[11px] text-muted-foreground">
                    change it from the header chip
                  </span>
                </Row>
              )}
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
