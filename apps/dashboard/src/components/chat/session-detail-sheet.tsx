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
// how a session behaves — the mode — was the read-only one. A Claude Code or
// codex session does show which model it runs, because those two are switchable
// now — from the chip in the chat header, which is the only control
// (chat/model-chip.tsx).
//
// Every rule below — which card is selected, whether Apply is live, what the
// confirm says, what the mutation sends, and every row in the read-only
// sections — lives in `session-detail-core.ts`, which the iOS port is held
// against (apps/ios/tools/detail-fixture.sh). This file is the widgets.

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Check, Copy } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { copyText } from '@/lib/copy-text';
import { CtxBar } from '@/components/ctx-bar';
import { BackendPicker } from './backend-picker';
import { useScope } from '@/lib/use-scope';
import { piModeLabel, PI_MODE_CHOICES, PI_MODE_META, DEFAULT_PI_MODE, isPiMode, type PiMode } from '@/lib/pi-modes';
import {
  detailHeading, detailPickerView, detailSavePayload, detailSections, detailStamp,
  detailSwitchPrompt, sessionUrl, backendLabelOf,
  type DetailRow, type DetailSnapshot,
} from './session-detail-core';

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

/** One row of a read-only section, drawn from the core's answer. */
function DetailRowView({ r, agentName }: { r: DetailRow; agentName: string }) {
  if (r.kind === 'task') {
    // Not `Row`, whose label is uppercased — see the core's note.
    return (
      <div className="flex items-start gap-3 py-1.5 border-b border-border/40 last:border-0">
        <span className="w-20 shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
          {r.label}
        </span>
        <span className="min-w-0 flex-1 font-mono text-xs break-words text-foreground/90">{r.value}</span>
      </div>
    );
  }
  const body =
    r.kind === 'ctx' ? <CtxBar tokens={r.ctxTokens ?? null} total={r.ctxTotal ?? 0} />
    : r.kind === 'agent' ? (
      <Link
        href={`/agents?name=${encodeURIComponent(agentName)}`}
        className="font-mono text-xs hover:underline underline-offset-2"
      >
        {r.value}
      </Link>
    )
    : r.value === null ? DASH
    : <>{r.value}</>;
  return (
    <Row label={r.label} mono={r.mono && r.kind !== 'agent'}>
      {body}
      {r.note && <span className={cn('ml-2 font-sans text-[11px] text-muted-foreground')}>{r.note}</span>}
    </Row>
  );
}

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
  const d = q.data as DetailSnapshot | null | undefined;

  // The header shows the LINK to this session, not the bare id: the id on its
  // own was only ever a step towards a url someone had to assemble by hand.
  // Reading `window` during render is safe here — AuthGate mounts the app only
  // after hydration — and the '' fallback keeps a server render from throwing.
  const url = typeof window === 'undefined' ? '' : sessionUrl(window.location.origin, sessionId);
  // copyText falls back to execCommand when navigator.clipboard is missing
  // (plain http on the LAN) or rejects, and returns a boolean so a failure shows
  // on the button instead of being swallowed into a tap that does nothing.
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  async function copyUrl() {
    const ok = await copyText(url);
    setCopied(ok ? 'ok' : 'fail');
    setTimeout(() => setCopied('idle'), 1400);
  }

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
  // Adjusting state during render is React's own escape hatch for exactly this
  // (an effect here causes the cascading render the lint rule warns about).
  const [runtime, setRuntime] = useState<string | null>(null);
  const [mode, setMode] = useState<PiMode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [stamped, setStamped] = useState<string | null>(null);

  const stamp = detailStamp(sessionId, d);
  if (stamp && stamped !== stamp) {
    setStamped(stamp);
    setRuntime(null);
    setMode(null);
    setErr(null);
  }

  const view = detailPickerView({ d, cfg: cfg.data, form: { runtime, mode }, scoped: scope.scoped });
  const { shownBackend, shownIsPi, shownMode, currentMode, dirty, working, readOnly } = view;

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

  async function submit() {
    if (!d || !dirty) return;
    const prompt = detailSwitchPrompt(d, cfg.data, view);
    const ok = await confirm({
      title: prompt.title,
      message: <>{prompt.message.map((p, i) => (p.em ? <em key={i}>{p.text}</em> : <span key={i}>{p.text}</span>))}</>,
      confirmLabel: prompt.confirmLabel,
    });
    if (!ok) return;
    save.mutate(detailSavePayload(d, view));
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
          <SheetTitle className="truncate">{detailHeading(d)}</SheetTitle>
          <div className="flex items-start gap-1">
            {/* Wraps rather than truncates: the tail of a session url is the id,
                which is the half worth reading, and on a phone an ellipsis eats
                exactly that. */}
            <SheetDescription className="min-w-0 flex-1 pt-1 font-mono text-[11px] break-all">
              {url}
            </SheetDescription>
            {/* Same size and variant as the sheet's own close X, and -mr-1 pulls
                it onto the same right edge (the header pads 4 more than the X's
                absolute inset) — one column, two buttons. */}
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mr-1 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Copy session link"
              title={copied === 'fail' ? 'Copy failed' : copied === 'ok' ? 'Copied' : 'Copy link'}
              onClick={copyUrl}
            >
              {copied === 'ok'
                ? <Check className="text-emerald-500" />
                : <Copy className={cn(copied === 'fail' && 'text-rose-400')} />}
            </Button>
          </div>
        </SheetHeader>

        {q.isPending && (
          <div className="p-6 space-y-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-32" />
          </div>
        )}

        {q.data === null && (
          <div className="p-6 text-sm text-muted-foreground animate-in fade-in-0">This session no longer exists.</div>
        )}

        {d && (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5 animate-in fade-in-0">
            {/* The core puts `background` first, and only when there is any: this
                sheet opens from the status chip, and when that chip says
                "background" this is the answer it was tapped for — a permanent
                empty row above the backend picker would be neither. The other
                sections follow the picker. */}
            {detailSections({ d, readOnly }).map((s) => (
              s.title === 'background' ? (
                <Section key={s.title} title={s.title}>
                  {s.rows.map((r, i) => <DetailRowView key={i} r={r} agentName={d.agentName} />)}
                  {s.footer && (
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{s.footer}</p>
                  )}
                </Section>
              ) : null
            ))}

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
              {shownIsPi && (
                <label className="mt-2.5 block">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">mode</span>
                  <Select
                    value={String(shownMode)}
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
                    {view.modeBlurb ? `${view.modeBlurb} ` : ''}
                    {view.modeSource}
                  </span>
                </label>
              )}

              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{view.inheritedLine}</p>

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
                    stopped — the next message starts it on {backendLabelOf(cfg.data, d.backend.backendId)}
                    {d.backend.runtime === 'pi-rpc' && ` · ${piModeLabel(currentMode)}`}
                  </span>
                )}
              </div>
            </Section>

            {detailSections({ d, readOnly }).map((s) => (
              s.title === 'background' ? null : (
                <Section key={s.title} title={s.title}>
                  {s.rows.map((r, i) => <DetailRowView key={i} r={r} agentName={d.agentName} />)}
                </Section>
              )
            ))}
          </div>
        )}

        {q.error && <div className="p-6 text-sm text-rose-400">error: {q.error.message}</div>}
      </SheetContent>
    </Sheet>
  );
}
