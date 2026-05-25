'use client';

import { useEffect, useMemo, useRef, useState, useCallback, type ChangeEvent, type ClipboardEvent, type DragEvent, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { MenuIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Markdown } from '@/components/markdown';
import { CtxBar } from '@/components/ctx-bar';
import { getStoredKey } from '@/app/providers';

type Block = { type: string; text?: string; name?: string; input?: any; tool_use_id?: string; content?: any; source?: any; width?: number; height?: number };

// In-flight or finished image upload attached to the composer.
type Attachment =
  | { id: string; kind: 'uploading'; name: string; previewUrl: string }
  | { id: string; kind: 'ready'; name: string; previewUrl: string; data: { url: string; mimeType: string; width: number | null; height: number | null } }
  | { id: string; kind: 'error'; name: string; error: string };

function ymdLocal(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
}
function isSameDay(a: Date | string, b: Date | string): boolean {
  const x = typeof a === 'string' ? new Date(a) : a;
  const y = typeof b === 'string' ? new Date(b) : b;
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatPageInner />
    </Suspense>
  );
}

function ChatPageInner() {
  const search = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 10_000 });
  const sessions = trpc.chat.listSessions.useQuery({}, { refetchInterval: 5_000 });

  // Prefetch message history for every session in the sidebar so opening one
  // is instant. Stagger by 80 ms so we don't fire N parallel requests at once.
  const utils = trpc.useUtils();
  useEffect(() => {
    if (!sessions.data) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    sessions.data.slice(0, 20).forEach((s, i) => {
      timers.push(
        setTimeout(() => {
          void utils.chat.listMessages.prefetch(
            { sessionId: s.id, limit: 300 },
            { staleTime: 60_000 },
          );
        }, i * 80),
      );
    });
    return () => { timers.forEach(clearTimeout); };
  }, [sessions.data, utils]);

  // Deep-link: /chat?agent=foo → open new-session form preset with that agent.
  const agentParam = search.get('agent');
  useEffect(() => {
    if (agentParam) setNewOpen(true);
  }, [agentParam]);

  // Deep-link: /chat?session=<id> → jump straight to that session.
  const sessionParam = search.get('session');
  useEffect(() => {
    if (sessionParam) setSelectedId(sessionParam);
  }, [sessionParam]);

  useEffect(() => {
    if (!selectedId && sessions.data && sessions.data.length > 0) {
      setSelectedId(sessions.data[0].id);
    }
  }, [sessions.data, selectedId]);

  // Close drawer when the viewport crosses the lg breakpoint (1024px), so a
  // resize from mobile→desktop doesn't leave a stale fixed/transparent overlay
  // floating over the chat content.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => { if (mq.matches) setDrawerOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Mobile drawer: Escape key closes.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // Mobile drawer: lock body scroll while open so the page underneath doesn't
  // peek scroll under the backdrop.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    if (drawerOpen) document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [drawerOpen]);

  return (
    <div className="h-[calc(100vh-3.5rem)] grid grid-rows-1 lg:grid-cols-[280px_1fr] overflow-hidden bg-background">
      {/* mobile-only backdrop — lg:hidden hides it on desktop */}
      <div
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
        className={cn(
          'lg:hidden fixed inset-0 z-30 bg-foreground/20 transition-opacity duration-150',
          drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
      />
      <aside
        className={cn(
          'border-r border-border bg-background flex flex-col',
          // mobile: fixed slide-out drawer below the nav (top-14 = h-14 nav)
          'fixed top-14 bottom-0 left-0 z-40 w-[280px] transition-transform duration-150 ease-out',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
          // desktop: in-flow
          'lg:static lg:translate-x-0 lg:z-0 lg:w-auto',
        )}
        aria-label="sessions"
      >
        <div className="px-3 h-11 border-b border-border flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">
            Sessions <span className="text-muted-foreground/50">·</span> <span className="text-foreground tabular-nums">{sessions.data?.length ?? 0}</span>
          </span>
          <Button size="sm" variant="ghost" className="h-7 text-xs px-2 -mr-1" onClick={() => setNewOpen((v) => !v)}>
            + new
          </Button>
        </div>

        {newOpen && (
          <NewSessionForm
            agents={(agents.data ?? []).map((a) => a.name)}
            preset={agentParam ?? undefined}
            onCreated={(id) => {
              setNewOpen(false);
              setSelectedId(id);
              sessions.refetch();
            }}
            onCancel={() => setNewOpen(false)}
          />
        )}

        <ScrollArea className="flex-1">
          {sessions.isPending ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : sessions.data?.length === 0 ? (
            <p className="p-4 text-xs text-zinc-500">no sessions yet. tap &quot;+ new&quot; to start one.</p>
          ) : (
            <ul className="py-1">
              {sessions.data?.map((s) => {
                const selected = selectedId === s.id;
                const initials = s.agentName.slice(0, 2).toUpperCase();
                return (
                  <li
                    key={s.id}
                    onClick={() => { setSelectedId(s.id); setDrawerOpen(false); }}
                    className={cn(
                      'group relative mx-1 my-px rounded-md cursor-pointer transition-colors',
                      selected ? 'bg-accent' : 'hover:bg-accent/50',
                      s.closedAt && 'opacity-60',
                    )}
                  >
                    <div className="flex items-center gap-2.5 px-2.5 py-2 min-w-0">
                      <div
                        className={cn(
                          'h-7 w-7 shrink-0 rounded-md flex items-center justify-center font-mono text-[10px] font-medium',
                          selected
                            ? 'bg-foreground text-background'
                            : 'bg-muted text-muted-foreground group-hover:text-foreground',
                        )}
                        aria-hidden="true"
                      >
                        {initials}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className={cn('text-sm truncate', selected ? 'text-foreground font-medium' : 'text-foreground/90')}>
                            {s.title || s.agentName}
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground/70 shrink-0 tabular-nums">
                            {relTime(s.lastMessageAt ?? s.startedAt)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/80">
                          <span className="truncate">{s.agentName}</span>
                          <span className="text-muted-foreground/40">·</span>
                          <span className="tabular-nums">{s._count.messages}</span>
                          {s.closedAt && <span className="text-muted-foreground/60">· closed</span>}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </aside>

      {/* min-h-0 is the critical bit: without it, a tall ScrollArea expands the
         flex column past viewport and pushes ComposeBar off-screen. With it,
         flex-1 children clamp to remaining height and scroll internally. */}
      <main className="flex flex-col min-w-0 min-h-0 overflow-hidden">
        {selectedId ? (
          <SessionPane sessionId={selectedId} onOpenDrawer={() => setDrawerOpen(true)} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <Button
              variant="ghost"
              size="sm"
              className="lg:hidden"
              onClick={() => setDrawerOpen(true)}
            >
              <MenuIcon className="h-4 w-4" /> open sessions
            </Button>
            <span className="hidden lg:block">pick a session on the left, or &quot;+ new&quot;</span>
            <span className="lg:hidden text-xs text-muted-foreground">tap above, or &quot;+ new&quot; inside the drawer</span>
          </div>
        )}
      </main>
    </div>
  );
}

function NewSessionForm({ agents, preset, onCreated, onCancel }: { agents: string[]; preset?: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [agent, setAgent] = useState(preset && agents.includes(preset) ? preset : agents[0] ?? '');
  const [title, setTitle] = useState('');
  const create = trpc.chat.createSession.useMutation({
    onSuccess: (s) => onCreated(s.id),
  });
  return (
    <form
      className="p-3 space-y-2 border-b border-border bg-muted/30"
      onSubmit={(e) => {
        e.preventDefault();
        if (agent) create.mutate({ agentName: agent, title: title || undefined });
      }}
    >
      <select
        value={agent}
        onChange={(e) => setAgent(e.target.value)}
        className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm font-mono text-foreground"
      >
        {agents.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="title (optional)"
        className="font-mono text-sm"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!agent || create.isPending} className="flex-1">
          {create.isPending ? 'creating…' : 'create'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>cancel</Button>
      </div>
      {create.error && <p className="text-xs text-rose-500">{create.error.message}</p>}
    </form>
  );
}

function SessionPane({ sessionId, onOpenDrawer }: { sessionId: string; onOpenDrawer?: () => void }) {
  const utils = trpc.useUtils();
  const sessionMeta = trpc.chat.listSessions.useQuery({});
  const session = sessionMeta.data?.find((s) => s.id === sessionId);
  // Aggressive 600ms poll during a turn (assistant streaming) and back to 2s
  // when idle. Cheap on the dashboard side; gateway flushes every 200ms.
  const messages = trpc.chat.listMessages.useQuery(
    { sessionId, limit: 300 },
    {
      // Active turn — either we're waiting on the assistant (last row is user)
      // OR the assistant just produced something very recently and is likely
      // still streaming chunks — poll at 600ms so the bubble grows visibly.
      // Idle conversation falls back to 2s.
      refetchInterval: (q) => {
        const last = q.state.data?.[q.state.data.length - 1];
        if (!last) return 2_000;
        if (last.role === 'user') return 600;
        const ageMs = Date.now() - new Date(last.createdAt).getTime();
        if (ageMs < 3_000) return 600;
        return 2_000;
      },
      // Revisiting a session within 1 min skips the network roundtrip entirely
      // (cache is considered fresh). Combined with the sidebar prefetch in
      // ChatPageInner, virtually every session click is a cache hit — no
      // Skeleton flash, no waiting. `refetchInterval` still drives background
      // updates while the user is looking at the session.
      staleTime: 60_000,
    },
  );

  const send = trpc.chat.send.useMutation({
    onSuccess: () => {
      utils.chat.listMessages.invalidate({ sessionId });
      utils.chat.listSessions.invalidate();
    },
  });
  const cancelTurn = trpc.chat.cancelTurn.useMutation({
    onSuccess: () => {
      utils.chat.listMessages.invalidate({ sessionId });
    },
  });
  const closeS = trpc.chat.closeSession.useMutation({ onSuccess: () => sessionMeta.refetch() });
  const reopenS = trpc.chat.reopenSession.useMutation({ onSuccess: () => sessionMeta.refetch() });

  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = scrollRef.current?.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.data?.length]);

  // user message just sent + still pending? (deliveredAt null on the latest user row)
  const lastMsg = messages.data?.[messages.data.length - 1];
  const isWaitingAssistant = lastMsg?.role === 'user';

  // Streaming detection: gateway upserts the assistant row by externalId, so a
  // growing bubble is visible as its `content` JSON changing between polls.
  // Treat the row as "still streaming" while it has grown within the last
  // ~1.8s; that window covers the gap between flushes (gateway flushes every
  // 200ms, dashboard polls at 600ms during active turns).
  const lastSigRef = useRef<{ id: string; sig: string; lastGrewAt: number } | null>(null);
  const [streamingTailId, setStreamingTailId] = useState<string | null>(null);
  useEffect(() => {
    const last = messages.data?.[messages.data.length - 1];
    if (!last || last.role !== 'assistant') {
      lastSigRef.current = null;
      setStreamingTailId(null);
      return;
    }
    const sig = JSON.stringify(last.content);
    const prev = lastSigRef.current;
    if (!prev || prev.id !== last.id || prev.sig !== sig) {
      lastSigRef.current = { id: last.id, sig, lastGrewAt: Date.now() };
      setStreamingTailId(last.id);
    }
  }, [messages.data]);
  // Tick to clear streamingTailId once the bubble has been quiet for >1.8s.
  useEffect(() => {
    if (!streamingTailId) return;
    const id = setInterval(() => {
      const prev = lastSigRef.current;
      if (!prev || Date.now() - prev.lastGrewAt > 1800) {
        setStreamingTailId(null);
      }
    }, 400);
    return () => clearInterval(id);
  }, [streamingTailId]);

  // ESC while a turn is in flight = click Stop. Lives at the document level
  // since the textarea is disabled during streaming and can't receive keys.
  const isInFlight = isWaitingAssistant || !!streamingTailId;
  useEffect(() => {
    if (!isInFlight || session?.closedAt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (cancelTurn.isPending) return;
      e.preventDefault();
      cancelTurn.mutate({ sessionId });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isInFlight, session?.closedAt, sessionId, cancelTurn]);

  // Empty-state chip → fills compose, focuses caret at end, triggers resize.
  const pickPrompt = useCallback((text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
    });
  }, []);

  return (
    <>
      <div className="border-b border-border px-4 h-11 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {onOpenDrawer && (
            <button
              type="button"
              onClick={onOpenDrawer}
              className="lg:hidden -ml-1 p-1.5 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
              aria-label="open sessions"
            >
              <MenuIcon className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium truncate text-foreground">
              <span className="truncate">{session?.title || session?.agentName || sessionId.slice(0, 8)}</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground truncate">
              <span className="text-foreground/70">{session?.agentName}</span>
              {session && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="inline-flex items-center gap-1">
                    <span className={`h-1.5 w-1.5 rounded-full ${session.alive ? 'bg-emerald-500' : 'bg-zinc-500'}`} />
                    {session.alive ? session.state ?? 'live' : 'idle'}
                  </span>
                  {session.contextTokens != null && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <CtxBar tokens={session.contextTokens} />
                    </>
                  )}
                </>
              )}
              {session?.closedAt && <><span className="text-muted-foreground/40">·</span><span className="text-muted-foreground">closed</span></>}
            </div>
          </div>
        </div>
        {session?.closedAt ? (
          <Button size="sm" variant="ghost" onClick={() => reopenS.mutate({ id: sessionId })}>
            reopen
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => closeS.mutate({ id: sessionId })}>
            close
          </Button>
        )}
      </div>

      <ScrollArea ref={scrollRef} className="flex-1 min-h-0 bg-background">
        <div className="px-4 py-4 max-w-3xl mx-auto">
          {messages.isPending ? (
            <Skeleton className="h-32" />
          ) : messages.data?.length === 0 ? (
            <EmptyChat agentName={session?.agentName} onPickPrompt={pickPrompt} />
          ) : (
            <MessageTimeline messages={messages.data ?? []} streamingTailId={streamingTailId} />
          )}
          {/* Only show the standalone dots-below indicator while the assistant
              has not yet emitted any content. Once the bubble appears, dots
              live inline at the bubble's tail (StreamingDots). */}
          {isWaitingAssistant && !streamingTailId && <TypingIndicator />}
        </div>
      </ScrollArea>

      <ComposeBar
        sessionId={sessionId}
        disabled={!!session?.closedAt}
        sending={send.isPending}
        inFlight={isInFlight}
        stopping={cancelTurn.isPending}
        onStop={() => cancelTurn.mutate({ sessionId })}
        onSend={(text, images) =>
          send.mutate(
            { sessionId, text, images },
            { onSuccess: () => { setDraft(''); setAttachments([]); } },
          )
        }
        draft={draft}
        setDraft={setDraft}
        attachments={attachments}
        setAttachments={setAttachments}
        taRef={taRef}
      />
    </>
  );
}

function MessageTimeline({ messages, streamingTailId }: { messages: Array<{ id: string; role: string; content: any; createdAt: Date | string }>; streamingTailId?: string | null }) {
  // Insert date dividers when day rolls over. Also coalesce consecutive
  // tool-result-only messages into a single row so a parallel-fanout batch
  // (e.g. 6 Read calls → 6 result rows) collapses to one expandable chip.
  const out: React.ReactNode[] = [];
  let prevDay: Date | string | null = null;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!prevDay || !isSameDay(prevDay, m.createdAt)) {
      out.push(<DateDivider key={`d-${m.id}`} day={m.createdAt} />);
      prevDay = m.createdAt;
    }
    const blocks = m.content as Block[];
    const isToolResultOnly = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
    if (isToolResultOnly) {
      const combined: Block[] = [...blocks];
      let lastId = m.id;
      let j = i + 1;
      while (j < messages.length) {
        const nb = messages[j].content as Block[];
        const nIsToolResultOnly = nb.length > 0 && nb.every((b) => b.type === 'tool_result');
        if (!nIsToolResultOnly) break;
        if (!isSameDay(prevDay!, messages[j].createdAt)) break;
        combined.push(...nb);
        lastId = messages[j].id;
        j++;
      }
      out.push(<MessageRow key={`g-${m.id}-${lastId}`} role={m.role} content={combined} ts={m.createdAt} />);
      i = j;
    } else {
      const streamingTail = !!streamingTailId && m.id === streamingTailId;
      out.push(<MessageRow key={m.id} role={m.role} content={blocks} ts={m.createdAt} streamingTail={streamingTail} />);
      i += 1;
    }
  }
  return <div className="space-y-3">{out}</div>;
}

function DateDivider({ day }: { day: Date | string }) {
  const label = useMemo(() => {
    const x = typeof day === 'string' ? new Date(day) : day;
    const now = new Date();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (isSameDay(x, now)) return 'Today';
    if (isSameDay(x, yesterday)) return 'Yesterday';
    return ymdLocal(x);
  }, [day]);
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-border" />
      <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground/70">{label}</span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start mt-2">
      <StreamingDots variant="bubble" />
    </div>
  );
}

function EmptyChat({ agentName, onPickPrompt }: { agentName?: string; onPickPrompt: (s: string) => void }) {
  const initials = (agentName ?? '?').slice(0, 2).toUpperCase();
  const suggestions = useMemo(
    () => [
      `say hi to ${agentName ?? 'them'}`,
      'what are you working on right now?',
      'anything broken? show me recent failures from your daily log',
    ],
    [agentName],
  );
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div
        className="h-12 w-12 rounded-md bg-muted text-muted-foreground flex items-center justify-center font-mono text-xs font-medium"
        aria-hidden="true"
      >
        {initials}
      </div>
      <h3 className="mt-4 text-sm font-medium text-foreground">
        Start a chat with <span className="font-mono">{agentName ?? '?'}</span>
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">pick a prompt or type your own below</p>
      <div className="w-full max-w-md mt-6 space-y-1">
        {suggestions.map((text, i) => (
          <button
            type="button"
            key={i}
            onClick={() => onPickPrompt(text)}
            className="group w-full flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-sm text-foreground/80 hover:text-foreground hover:border-foreground/30 hover:bg-accent/40 transition-colors cursor-pointer"
          >
            <span className="flex-1 truncate">{text}</span>
            <span className="text-muted-foreground/60 group-hover:text-emerald-600 text-[11px] font-mono transition-colors" aria-hidden="true">↵</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ComposeBar({
  sessionId,
  disabled,
  sending,
  inFlight,
  stopping,
  onStop,
  draft,
  setDraft,
  attachments,
  setAttachments,
  onSend,
  taRef,
}: {
  sessionId: string;
  disabled: boolean;
  sending: boolean;
  inFlight: boolean;
  stopping: boolean;
  onStop: () => void;
  draft: string;
  setDraft: (s: string) => void;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  onSend: (text: string, images: Array<{ url: string; mimeType: string; width: number | null; height: number | null }>) => void;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
}) {

  // Auto-resize textarea: clamp height between 1 and 12 rows.
  const onChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
  }, [setDraft]);

  // Upload one or more image files to /api/upload; track each via an
  // Attachment record so the UI can show a thumbnail+spinner during upload.
  const addFiles = useCallback(async (files: File[]) => {
    const ok = files.filter((f) => f.type.startsWith('image/'));
    if (ok.length === 0) return;
    for (const file of ok) {
      const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
      const previewUrl = URL.createObjectURL(file);
      setAttachments((prev) => [...prev, { id, kind: 'uploading', name: file.name || 'pasted-image', previewUrl }]);
      try {
        const fd = new FormData();
        fd.append('sessionId', sessionId);
        fd.append('file', file);
        const r = await fetch('/api/upload', { method: 'POST', headers: { 'x-asst-key': getStoredKey() }, body: fd });
        if (!r.ok) throw new Error(`upload failed (${r.status}): ${await r.text().catch(() => '')}`);
        const data = await r.json() as { url: string; mimeType: string; width: number | null; height: number | null };
        setAttachments((prev) => prev.map((a) => a.id === id ? { id, kind: 'ready', name: file.name || 'pasted-image', previewUrl, data: { url: data.url, mimeType: data.mimeType, width: data.width, height: data.height } } : a));
      } catch (e) {
        setAttachments((prev) => prev.map((a) => a.id === id ? { id, kind: 'error', name: file.name || 'pasted-image', error: e instanceof Error ? e.message : String(e) } : a));
      }
    }
  }, [sessionId, setAttachments]);

  const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && f.type.startsWith('image/')) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }, [addFiles]);

  const [dragHover, setDragHover] = useState(false);
  const onDragOver = useCallback((e: DragEvent<HTMLFormElement>) => {
    if (Array.from(e.dataTransfer.items).some((it) => it.kind === 'file')) {
      e.preventDefault();
      setDragHover(true);
    }
  }, []);
  const onDragLeave = useCallback(() => setDragHover(false), []);
  const onDrop = useCallback((e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDragHover(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void addFiles(files);
  }, [addFiles]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target && 'previewUrl' in target && target.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((a) => a.id !== id);
    });
  }, [setAttachments]);

  const readyAttachments = useMemo(
    () => attachments.filter((a): a is Attachment & { kind: 'ready' } => a.kind === 'ready'),
    [attachments],
  );
  const uploadingCount = attachments.filter((a) => a.kind === 'uploading').length;

  const submit = () => {
    const text = draft.trim();
    if (sending || disabled || inFlight) return;
    if (!text && readyAttachments.length === 0) return;
    onSend(
      text,
      readyAttachments.map((a) => ({ url: a.data.url, mimeType: a.data.mimeType, width: a.data.width, height: a.data.height })),
    );
  };

  // While the assistant is producing output, swap the green send button for a
  // rose-tinted stop. Click → POST chat.cancelTurn → gateway sends Escape.
  const showStop = inFlight && !disabled;
  const canSend = !sending && !disabled && !inFlight && (draft.trim().length > 0 || readyAttachments.length > 0);

  return (
    <form
      className={cn(
        'shrink-0 border-t border-border bg-background px-4 py-3 transition-colors',
        dragHover && 'bg-accent/30',
      )}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="max-w-3xl mx-auto space-y-2">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} onRemove={() => removeAttachment(a.id)} />
            ))}
          </div>
        )}
        <div
          className={cn(
            'flex items-end gap-2 rounded-md border bg-background pl-3 pr-1.5 py-1.5 transition-colors duration-100 ease-out',
            disabled
              ? 'border-border opacity-60'
              : showStop
              ? 'border-rose-500/40'
              : dragHover
              ? 'border-foreground/40'
              : 'border-border focus-within:border-foreground/30',
          )}
        >
          <textarea
            ref={taRef}
            value={draft}
            onChange={onChange}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // IME composition (中文输入法 etc.): Enter confirms a candidate,
              // not a send. keyCode 229 covers older browsers that don't set
              // isComposing.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.shiftKey) return;
              e.preventDefault();
              submit();
            }}
            placeholder={
              disabled
                ? 'session is closed'
                : showStop
                ? 'assistant is working… (esc to stop)'
                : uploadingCount > 0
                ? `uploading ${uploadingCount}…`
                : 'message (↵ to send · ⇧↵ newline · paste/drop images to attach)'
            }
            disabled={disabled || showStop}
            rows={1}
            className="flex-1 bg-transparent text-sm resize-none outline-none leading-relaxed min-h-[24px] max-h-[360px] overflow-auto py-1.5 text-foreground placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
          />
          {showStop ? (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="rounded h-7 w-7 p-0 shrink-0 inline-flex items-center justify-center cursor-pointer text-rose-500 hover:bg-rose-500/10 disabled:opacity-50 disabled:cursor-wait transition-colors"
              aria-label={stopping ? 'stopping' : 'stop assistant turn'}
              title={stopping ? 'stopping…' : 'stop assistant turn'}
            >
              <span className="h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              className={cn(
                'rounded h-7 w-7 p-0 shrink-0 inline-flex items-center justify-center text-sm transition-colors',
                canSend
                  ? 'text-background bg-foreground hover:bg-foreground/90 cursor-pointer'
                  : 'text-muted-foreground/50 bg-muted cursor-not-allowed',
              )}
              aria-label="send"
            >
              {sending ? '…' : '↑'}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function AttachmentChip({ attachment: a, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const previewUrl = 'previewUrl' in a ? a.previewUrl : null;
  return (
    <div className="relative group inline-flex items-center gap-2 rounded-md border border-border bg-background px-1.5 py-1 text-[11px] font-mono">
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt={a.name} className={cn(
          'h-10 w-10 rounded object-cover',
          a.kind === 'uploading' && 'opacity-50',
          a.kind === 'error' && 'opacity-30 grayscale',
        )} />
      ) : (
        <div className="h-10 w-10 rounded bg-muted text-muted-foreground/60 flex items-center justify-center">!</div>
      )}
      <div className="min-w-0 max-w-[120px]">
        <div className="truncate text-foreground/80">{a.name}</div>
        <div className={cn(
          'text-[10px] tabular-nums',
          a.kind === 'uploading' && 'text-muted-foreground',
          a.kind === 'ready' && 'text-emerald-600',
          a.kind === 'error' && 'text-rose-500',
        )}>
          {a.kind === 'uploading' ? 'uploading…' : a.kind === 'ready' ? `${a.data.width ?? '?'}×${a.data.height ?? '?'}` : a.error.slice(0, 40)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="remove attachment"
        className="opacity-60 hover:opacity-100 hover:text-rose-500 px-1 text-xs cursor-pointer"
      >
        ×
      </button>
    </div>
  );
}

function MessageRow({ role, content, ts, streamingTail = false }: { role: string; content: Block[]; ts: Date | string; streamingTail?: boolean }) {
  // Tool-result-only rows belong with the assistant's preceding tool calls,
  // so we render them as condensed inline chips with no bubble.
  const allToolResults = content.length > 0 && content.every((b) => b.type === 'tool_result');
  if (allToolResults) {
    const results = content as Array<{ type: string; tool_use_id?: string; content?: any; is_error?: boolean }>;
    if (results.length === 1) {
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%]"><InlineToolResult block={results[0]} /></div>
        </div>
      );
    }
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%]"><InlineToolResultBatch results={results} /></div>
      </div>
    );
  }

  const isHumanUser = role === 'user';
  const isSystem = role === 'system';

  // Group consecutive same-tool tool_use calls so a noisy claude turn doesn't
  // generate 12 individual cards.
  const grouped = groupConsecutiveTools(content);
  const hasVisibleText = content.some((b) => b.type === 'text' && (b as any).text?.trim());

  // Tool-use-only assistant turns: render the chips bare (no bubble, no
  // placeholder text). They belong visually with the surrounding tool_result
  // chips, not as standalone cards with empty bodies. When this row is the
  // streaming tail, append a small dots chip at the end of the chip cluster.
  if (!isHumanUser && !isSystem && !hasVisibleText && grouped.every((g) => g.kind === 'tool' || g.kind === 'thinking')) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] space-y-1.5">
          {grouped.map((g, i) => (
            <GroupView key={i} group={g} dark inline />
          ))}
          {streamingTail && (
            <div className="flex">
              <StreamingDots variant="chip" />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isHumanUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={cn(
          'max-w-[85%] space-y-2 text-sm',
          isHumanUser
            ? 'rounded-md px-3 py-2 bg-foreground text-background'
            : isSystem
              ? 'rounded-md px-3 py-2 border border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-200'
              : 'text-foreground/90',
        )}
      >
        {grouped.map((g, i) => (
          <GroupView key={i} group={g} dark={false} />
        ))}
        {streamingTail && (
          <div className="flex">
            <StreamingDots variant="bubble" />
          </div>
        )}
        <div className={cn(
          'text-[10px] font-mono pt-0.5 tabular-nums',
          isHumanUser ? 'text-background/60' : 'text-muted-foreground/60',
        )}>
          {relTime(ts)}
        </div>
      </div>
    </div>
  );
}

// Tail-of-bubble streaming indicator. A single thin animated line — modern
// minimal, no bouncing dots. The line slides left→right inside a track to
// signal "still working" without competing for visual attention.
function StreamingDots({ variant }: { variant: 'bubble' | 'chip' }) {
  return (
    <span
      aria-label="assistant is still working"
      className={cn(
        'relative inline-block h-px overflow-hidden',
        variant === 'chip' ? 'w-16' : 'w-24',
      )}
    >
      <span className="absolute inset-y-0 left-0 w-full bg-border" />
      <span className="absolute inset-y-0 -left-1/3 w-1/3 bg-emerald-500 animate-[stream_1.2s_ease-in-out_infinite]" />
    </span>
  );
}

type Group =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; calls: Array<{ id: string; name: string; input: any }> }
  | { kind: 'image'; url: string; mimeType: string | null; width: number | null; height: number | null }
  | { kind: 'unknown'; block: Block };

// Coerce an Anthropic image block's `source` into a URL the dashboard can show.
// Three variants in the wild:
//   { type: 'url', url: '/uploads/...' }              → our composer uploads
//   { type: 'url', url: 'https://…' }                 → external (gateway-relayed)
//   { type: 'base64', media_type, data }              → MCP attach_image-style
function imageSourceToUrl(src: any): { url: string; mimeType: string | null } | null {
  if (!src || typeof src !== 'object') return null;
  if (src.type === 'url' && typeof src.url === 'string') {
    return { url: src.url, mimeType: src.media_type ?? null };
  }
  if (src.type === 'base64' && typeof src.data === 'string') {
    const mt = src.media_type || 'image/png';
    return { url: `data:${mt};base64,${src.data}`, mimeType: mt };
  }
  return null;
}

function groupConsecutiveTools(blocks: Block[]): Group[] {
  const out: Group[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      if (b.text) out.push({ kind: 'text', text: b.text });
    } else if (b.type === 'thinking') {
      const t = (b as any).thinking ?? (b as any).text;
      if (t) out.push({ kind: 'thinking', text: String(t) });
    } else if (b.type === 'tool_use') {
      const prev = out[out.length - 1];
      const call = { id: (b as any).id ?? '', name: (b as any).name ?? '?', input: (b as any).input ?? {} };
      if (prev && prev.kind === 'tool') prev.calls.push(call);
      else out.push({ kind: 'tool', calls: [call] });
    } else if (b.type === 'image') {
      const src = imageSourceToUrl(b.source);
      if (src) {
        out.push({
          kind: 'image',
          url: src.url,
          mimeType: src.mimeType,
          width: typeof b.width === 'number' ? b.width : null,
          height: typeof b.height === 'number' ? b.height : null,
        });
      }
    } else {
      out.push({ kind: 'unknown', block: b });
    }
  }
  return out;
}

function GroupView({ group, dark, inline = false }: { group: Group; dark: boolean; inline?: boolean }) {
  if (group.kind === 'text') return <Markdown>{group.text}</Markdown>;
  if (group.kind === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <a href={group.url} target="_blank" rel="noopener noreferrer" className="inline-block">
        <img
          src={group.url}
          alt={`attachment${group.width && group.height ? ` ${group.width}×${group.height}` : ''}`}
          className="max-w-[320px] max-h-[320px] rounded border border-border"
          loading="lazy"
        />
      </a>
    );
  }
  if (group.kind === 'thinking') {
    return (
      <details className="text-xs italic text-zinc-500/80">
        <summary className="cursor-pointer">💭 thinking</summary>
        <p className="mt-1 whitespace-pre-wrap">{group.text}</p>
      </details>
    );
  }
  if (group.kind === 'tool') {
    // Sub-group consecutive same-name calls so a turn with 8× Read renders as
    // a single "⚙ Read × 8" expandable chip instead of 8 wrapped chips.
    const byName: Array<{ name: string; calls: typeof group.calls }> = [];
    for (const c of group.calls) {
      const last = byName[byName.length - 1];
      if (last && last.name === c.name) last.calls.push(c);
      else byName.push({ name: c.name, calls: [c] });
    }
    return (
      <div className="flex flex-wrap gap-1.5">
        {byName.map((g, i) =>
          g.calls.length === 1 ? (
            <ToolChip key={g.calls[0].id || `${g.name}-${i}`} call={g.calls[0]} dark={dark} inline={inline} />
          ) : (
            <ToolBatchChip key={`${g.name}-${i}`} name={g.name} calls={g.calls} dark={dark} inline={inline} />
          ),
        )}
      </div>
    );
  }
  return (
    <pre className="text-[11px] whitespace-pre-wrap text-zinc-500">
      [{group.block.type}] {JSON.stringify(group.block, null, 2).slice(0, 200)}
    </pre>
  );
}

// Modern minimal chip surface — hairline border, no fills, no shadows.
function chipSurface(_dark: boolean, _inline: boolean): string {
  return 'border border-border bg-background hover:border-foreground/30 hover:bg-accent/40 transition-colors';
}

function ToolChip({ call, dark, inline = false }: { call: { id: string; name: string; input: any }; dark: boolean; inline?: boolean }) {
  const argPreview = useMemo(() => oneLineArg(call.input), [call.input]);
  return (
    <details className={`group rounded text-[11px] ${chipSurface(dark, inline)}`}>
      <summary className="cursor-pointer list-none flex items-center gap-1.5 px-2 py-1 font-mono">
        <span className="text-muted-foreground/70">→</span>
        <span className="font-medium text-foreground">{call.name}</span>
        {argPreview && <span className="text-muted-foreground truncate max-w-[32ch]">{argPreview}</span>}
      </summary>
      <pre className="mt-0 mx-0 border-t border-border px-2 py-1.5 text-[11px] whitespace-pre-wrap break-all bg-muted/40 text-foreground/80 rounded-b">
        {JSON.stringify(call.input, null, 2)}
      </pre>
    </details>
  );
}

function ToolBatchChip({ name, calls, dark, inline = false }: { name: string; calls: Array<{ id: string; name: string; input: any }>; dark: boolean; inline?: boolean }) {
  return (
    <details className={`group rounded text-[11px] ${chipSurface(dark, inline)}`}>
      <summary className="cursor-pointer list-none flex items-center gap-1.5 px-2 py-1 font-mono">
        <span className="text-muted-foreground/70">→</span>
        <span className="font-medium text-foreground">{name}</span>
        <span className="text-muted-foreground tabular-nums">× {calls.length}</span>
      </summary>
      <ul className="border-t border-border divide-y divide-border">
        {calls.map((c, i) => {
          const arg = oneLineArg(c.input);
          return (
            <li key={c.id || `${name}-${i}`} className="px-2 py-1 bg-muted/20">
              <details>
                <summary className="cursor-pointer list-none font-mono text-[11px] flex items-center gap-1.5">
                  <span className="text-muted-foreground/60 tabular-nums">{i + 1}.</span>
                  <span className="text-foreground/80 truncate">{arg || '(no arg)'}</span>
                </summary>
                <pre className="mt-1 px-2 py-1.5 rounded text-[10px] whitespace-pre-wrap break-all bg-muted/60 text-foreground/80">
                  {JSON.stringify(c.input, null, 2)}
                </pre>
              </details>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function InlineToolResult({ block }: { block: { type: string; tool_use_id?: string; content?: any; is_error?: boolean } }) {
  const text = useMemo(() => extractToolResultText(block.content), [block.content]);
  const isError = !!block.is_error;
  return (
    <details className={cn(
      'rounded text-[11px] border bg-background transition-colors',
      isError
        ? 'border-rose-500/40 bg-rose-500/5'
        : 'border-border hover:border-foreground/30',
    )}>
      <summary className="cursor-pointer list-none px-2 py-1 font-mono flex items-center gap-1.5">
        <span className={isError ? 'text-rose-500' : 'text-muted-foreground/70'}>←</span>
        <span className="text-foreground/80">result</span>
        <span className="text-muted-foreground truncate max-w-[60ch]">{firstLine(text)}</span>
      </summary>
      <pre className="border-t border-border px-2 py-1.5 text-[11px] whitespace-pre-wrap break-all bg-muted/40 text-foreground/80 rounded-b">
        {text}
      </pre>
    </details>
  );
}

function InlineToolResultBatch({ results }: { results: Array<{ type: string; tool_use_id?: string; content?: any; is_error?: boolean }> }) {
  const errCount = results.filter((r) => r.is_error).length;
  const ok = errCount === 0;
  return (
    <details className={cn(
      'rounded text-[11px] border bg-background transition-colors',
      ok ? 'border-border hover:border-foreground/30' : 'border-rose-500/40 bg-rose-500/5',
    )}>
      <summary className="cursor-pointer list-none px-2 py-1 font-mono flex items-center gap-1.5">
        <span className={ok ? 'text-muted-foreground/70' : 'text-rose-500'}>←</span>
        <span className="text-foreground/80 tabular-nums">{results.length} results</span>
        {errCount > 0 && <span className="text-rose-500 tabular-nums">· {errCount} error{errCount > 1 ? 's' : ''}</span>}
      </summary>
      <div className="border-t border-border p-1.5 space-y-1 bg-muted/20 rounded-b">
        {results.map((b, i) => (
          <InlineToolResult key={i} block={b} />
        ))}
      </div>
    </details>
  );
}

function oneLineArg(input: any): string {
  if (!input || typeof input !== 'object') return '';
  // Prefer common single-arg fields by name.
  for (const k of ['file_path', 'path', 'url', 'command', 'pattern', 'query', 'name', 'text']) {
    if (typeof input[k] === 'string') return shorten(input[k]);
  }
  // Fall back to first string value.
  for (const v of Object.values(input)) {
    if (typeof v === 'string') return shorten(v);
  }
  return '';
}
function shorten(s: string, n = 60) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return shorten(i >= 0 ? s.slice(0, i) : s, 80);
}
function extractToolResultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(content ?? {}, null, 2);
}
