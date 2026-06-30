'use client';

import { useCallback, useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Pencil, Check, X, ChevronDown, Download, Trash2, Package, Info, Folder } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { trpc } from '@/lib/trpc';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { Markdown } from './markdown';
import { CtxBar } from './ctx-bar';
import { PublishToMarketButton } from './publish-to-market-button';
import { InstallSkillDialog } from './install-skill-dialog';
import { PublishTemplateDialog } from './publish-template-dialog';
import { Overlay } from './overlay';
import { SkillFilesModal } from './skill-files-modal';
import { type FileItem as SkillFileItem } from './file-detail';
import { sessionStatusView } from '@/lib/session-status';
import { isSessionUnread } from '@/lib/session-read';
import { removeAgentSkill } from '@/lib/optimistic-skills';
import { AgentFiles } from './agent-files';
import { useScope } from '@/lib/use-scope';

type SessionRow = inferRouterOutputs<AppRouter>['chat']['listSessions'][number];
type AgentByNameOutput = NonNullable<inferRouterOutputs<AppRouter>['agents']['byName']>;

export type DetailTab = 'detail' | 'files';

// Keep the agent detail fresh after a gateway-applied change — a new agent's
// scaffold, or a skill install/uninstall — WITHOUT a manual refresh, and without
// fast-polling the heavy `byName` payload when nothing's happening.
//
// Both flows go through an AgentRequest the gateway materializes asynchronously
// (~3-6s) and then re-syncs. Right after install the cache shows the skill with
// EMPTY content (optimistic add, see optimistic-skills); a brand-new agent shows
// no skills until its scaffold lands — the "未显示" states the user sees. So:
//   · while a request for THIS agent is in flight → poll byName at 4s,
//   · the moment it resolves (gateway applied + the post-ack sync is landing) →
//     pull byName once more after a short beat, so the real content fills in,
//   · idle → byName stays at its cheap 30s baseline.
// pendingRequests is a tiny machine-scoped query (usually an empty array), so
// polling it at 3s while the panel is open is cheap.
function useAgentDetailRefresh(name: string | null, active: boolean): { refetchInterval: number } {
  const utils = trpc.useUtils();
  const { scoped } = useScope();
  const pending = trpc.agents.pendingRequests.useQuery(undefined, {
    // pendingRequests is machine-only (403 for a scoped share key). Skipping it
    // there keeps it OUT of byName's HTTP batch — a 403 sibling makes the whole
    // batch 207 and the client then reads byName as having no data, rendering a
    // bogus "agent not found".
    enabled: !!name && active && !scoped,
    // Adaptive like the other pendingRequests observers (RQ uses the min across
    // them, so this must agree or it'd undercut the idle back-off): fast only
    // while something's in flight, slow when idle. `enabled` gates it off otherwise.
    refetchInterval: (q) => (((q.state.data as unknown[] | undefined)?.length ?? 0) > 0 ? 2_000 : 12_000),
  });
  const inFlight = !!name && (pending.data ?? []).some((p) => p.agentName === name);
  const prev = useRef(inFlight);
  useEffect(() => {
    if (prev.current && !inFlight && name) {
      const t = setTimeout(() => { void utils.agents.byName.invalidate({ name }); }, 1_500);
      prev.current = inFlight;
      return () => clearTimeout(t);
    }
    prev.current = inFlight;
  }, [inFlight, name, utils]);
  return { refetchInterval: inFlight ? 4_000 : 30_000 };
}

// AgentDetailBody — renders the agent detail panel without a Sheet wrapper.
// Used by the inline /agents page. Owns its own queries; the active `tab` is
// owned by the caller so the tab strip (<AgentDetailTabs>) can ride the page
// header row next to the title + Chat/delete instead of taking its own line.
export function AgentDetailBody({ name, tab }: { name: string; tab: DetailTab }) {
  // Fast-poll while a create/install request for this agent is in flight, so the
  // panel fills in within seconds (no manual refresh); 30s when idle.
  const { refetchInterval } = useAgentDetailRefresh(name, true);
  const query = trpc.agents.byName.useQuery({ name }, { refetchInterval });
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
  if (query.error) return <div className="p-4 sm:p-6 text-sm text-rose-400">error: {query.error.message}</div>;
  if (!query.data) return <AgentMissing name={name} />;
  return <AgentDetailContent name={name} agent={query.data.agent} sessions={sessions.data ?? null} sessionsLoading={sessions.isPending} tab={tab} />;
}

// byName found no agent. Explain why: a create/import that ERRORED surfaces its
// message (with an Import hint for the common "directory already exists" case),
// instead of a bare "not found"; a genuine miss still falls back to "not found".
function AgentMissing({ name }: { name: string }) {
  const req = trpc.agents.latestRequest.useQuery({ name });
  if (req.isPending) return <div className="p-4 sm:p-6 text-sm text-muted-foreground">loading…</div>;
  const r = req.data;
  if (r && r.status === 'error') {
    const dirExists = /already exists/i.test(r.error ?? '');
    return (
      <div className="p-4 sm:p-6 max-w-xl space-y-2">
        <p className="text-sm font-medium text-rose-400">Couldn&apos;t {r.kind} &ldquo;{name}&rdquo;.</p>
        {r.error && <p className="text-xs text-muted-foreground break-words font-mono">{r.error}</p>}
        {dirExists && r.kind === 'create' && (
          <p className="text-xs text-muted-foreground">
            That path already holds an agent — use <span className="font-medium text-foreground">Import</span> (point it at the existing
            directory) instead of <span className="font-medium text-foreground">Create</span>, which scaffolds a fresh one and won&apos;t overwrite.
          </p>
        )}
      </div>
    );
  }
  return <div className="p-4 sm:p-6 text-sm text-muted-foreground">agent not found.</div>;
}

// The "详情 / 文件" tab strip — settings-strip styling (icon-only pills, see
// components/settings-tabs.tsx). Rendered in the parent's header row (page
// header / SheetHeader) so it shares the line with the title + actions.
export function AgentDetailTabs({ tab, setTab }: { tab: DetailTab; setTab: (t: DetailTab) => void }) {
  const pill = (active: boolean) =>
    cn(
      'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[13px] whitespace-nowrap transition-colors cursor-pointer',
      active ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
    );
  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={() => setTab('detail')} className={pill(tab === 'detail')} aria-label="Detail" title="Detail">
        <Info className="h-4 w-4" />
      </button>
      <button type="button" onClick={() => setTab('files')} className={pill(tab === 'files')} aria-label="Files" title="Files">
        <Folder className="h-4 w-4" />
      </button>
    </div>
  );
}

// Tabbed body, fill-height + controlled by `tab` (the strip lives in the parent
// header). "详情" scrolls (centered, max-w-3xl); "文件" is the file manager
// filling the whole pane. Fills its parent — wrap callers in a flex-1 min-h-0.
function AgentDetailContent({
  name,
  agent,
  sessions,
  sessionsLoading,
  tab,
}: {
  name: string;
  agent: AgentByNameOutput['agent'];
  sessions: SessionRow[] | null;
  sessionsLoading: boolean;
  tab: DetailTab;
}) {
  return (
    <div className="flex flex-col h-full min-h-0">
      {tab === 'files' ? (
        // Keyed by agent so the tree/selection resets to the new agent's root
        // when you switch agents while staying on the Files tab.
        <AgentFiles key={name} agentName={name} directory={agent.directory} />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-5">
            <SessionsSection agentName={name} sessions={sessions} loading={sessionsLoading} />
            <CronsSection agentName={name} />
            <SkillsAndTasks agent={agent} agentName={name} />
            <MarkdownSections agentName={name} />
            <TemplatePublishSection agentName={name} />
          </div>
        </div>
      )}
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
  // Idle metadata changes ~every 5min, so byName sits at 30s — but right after a
  // scaffold/install we fast-poll (4s) until the gateway's change lands, so the
  // panel fills in without a manual refresh. Only while the sheet is open.
  const { refetchInterval } = useAgentDetailRefresh(name, open);
  const query = trpc.agents.byName.useQuery(
    { name: name ?? '' },
    { enabled: !!name && open, refetchInterval: open ? refetchInterval : false },
  );
  const sessions = trpc.chat.listSessions.useQuery(
    { agentName: name ?? '' },
    { enabled: !!name && open, refetchInterval: open ? 5_000 : false },
  );
  const [tab, setTab] = useState<DetailTab>('detail');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* data-[side=right]: prefix is required: the base sheet sets
          data-[side=right]:sm:max-w-sm, which tailwind-merge keeps alongside a
          plain sm:max-w-* override and then wins on specificity. Match the
          variant so the wider cap actually takes effect. */}
      <SheetContent className="w-full sm:max-w-2xl data-[side=right]:sm:max-w-2xl overflow-hidden flex flex-col gap-0 p-0">
        <SheetHeader className="border-b">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <SheetTitle className="font-mono truncate">{name ?? '—'}</SheetTitle>
              <SheetDescription>
                {query.data?.agent.directory ? (
                  <span className="font-mono text-[11px] truncate block">{query.data.agent.directory}</span>
                ) : (
                  'agent workspace'
                )}
              </SheetDescription>
            </div>
            {query.data && <AgentDetailTabs tab={tab} setTab={setTab} />}
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
          <div className="flex-1 min-h-0">
            <AgentDetailContent name={name} agent={query.data.agent} sessions={sessions.data ?? null} sessionsLoading={sessions.isPending} tab={tab} />
          </div>
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
  const confirm = useConfirm();
  const deleteSession = trpc.chat.deleteSession.useMutation({
    onSuccess: () => {
      // Invalidate every listSessions variant so the row also vanishes from the
      // main sidebar, not just this agent-filtered list.
      utils.chat.listSessions.invalidate();
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
            const status = sessionStatusView(s, { unread: isSessionUnread(s) });
            // Only disable the row currently being deleted (isPending is shared
            // across rows, so narrow it by the in-flight variables' id).
            const deleting = deleteSession.isPending && deleteSession.variables?.id === s.id;
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
                      className="shrink-0 text-muted-foreground hover:text-rose-500"
                      disabled={deleting}
                      onClick={async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (await confirm({
                          title: 'Delete session',
                          message: 'Delete this session and its chat history? This cannot be undone.',
                          confirmLabel: 'Delete',
                          danger: true,
                        })) {
                          deleteSession.mutate({ id: s.id });
                        }
                      }}
                      aria-label="delete session"
                      title="Delete session (with chat history — cannot be undone)"
                    >
                      <Trash2 className={cn('size-3.5', deleting && 'animate-pulse')} />
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
          no scheduled tasks. create one with “Schedule a task” in a chat.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((c) => {
            const dot = !c.enabled
              ? 'bg-zinc-500'
              : c.lastStatus === 'fail' || c.lastStatus === 'error'
                ? 'bg-rose-500'
                : c.lastStatus === 'running'
                  ? 'bg-amber-500'
                  : c.lastStatus === 'ok'
                    ? 'bg-emerald-500'
                    : c.lastStatus === 'timeout' || c.lastStatus === 'no_output'
                      ? 'bg-amber-500' // inconclusive, not a failure
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
                        {c.unreadCount > 0 && (
                          <span
                            className="shrink-0 inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-mono tabular-nums leading-none"
                            title={`${c.unreadCount} 条未读执行`}
                          >
                            {c.unreadCount}
                          </span>
                        )}
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

// ── Skills (list → modal) ────────────────────────────────────────────────────

// A skill is "self-evolved" when its SKILL.md frontmatter carries `source:
// evolution` — the agent codified it itself (vs template / manual). Shows a 🧬
// badge so you can see what the agent has grown on its own.
function isEvolvedSkill(content: string | null): boolean {
  if (!content) return false;
  const fm = /^---\n([\s\S]*?)\n---/.exec(content);
  return !!fm && /(^|\n)\s*source\s*:\s*evolution\b/i.test(fm[1]);
}

function SkillsAndTasks({ agent, agentName }: { agent: AgentByNameOutput['agent']; agentName: string }) {
  const { scoped } = useScope();
  // Skill CONTENT is lazy — byName carries only skill NAMES now (the SKILL.md
  // bodies were ~150KB re-sent on every 30s detail poll). Fetch the bodies ONCE
  // here with a long staleTime. Falls back to a chip-only list while loading / if
  // the gateway hasn't synced contents yet.
  const contentsQ = trpc.agents.skillContents.useQuery({ name: agentName }, { staleTime: 5 * 60_000 });
  const skills = contentsQ.data ?? [];
  const hasContent = skills.length > 0;
  // Marketplace binding status — which skills are linked + have a newer version.
  const status = trpc.market.agentSkillStatus.useQuery({ agentName }, { refetchInterval: 30_000, enabled: !scoped });
  const statusMap = new Map((status.data ?? []).map((s) => [s.skillName, s]));
  const [installOpen, setInstallOpen] = useState(false);
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const items: FileItem[] = agent.skillNames.map((name) => {
    const content = skills.find((s) => s.name === name)?.content ?? null;
    const st = statusMap.get(name);
    return {
      key: `skill:${name}`,
      label: name,
      body: content,
      target: `skill:${name}`,
      monoLabel: true,
      evolved: isEvolvedSkill(content),
      publishSkill: name,
      market: st ? { bound: true, hasUpdate: st.hasUpdate, installedVersion: st.installedVersion, latestVersion: st.latestVersion, slug: st.slug } : undefined,
      onOpen: () => setOpenSkill(name),
    };
  });
  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
          skills · {agent.skillNames.length}
        </h3>
        <button
          type="button"
          onClick={() => setInstallOpen(true)}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <Download className="h-3.5 w-3.5" /> Install skill
        </button>
      </div>
      {agent.skillNames.length === 0 ? (
        <p className="text-xs text-muted-foreground">no skills installed under <code className="font-mono">.claude/skills/</code>.</p>
      ) : hasContent ? (
        <FileList items={items} agentName={agentName} />
      ) : (
        // Pre-sync fallback: chip-only list (no contents yet to view/edit).
        <div className="flex flex-wrap gap-1.5">
          {agent.skillNames.map((s) => (
            <Badge key={s} variant="outline" className="font-mono text-[11px]">{s}</Badge>
          ))}
        </div>
      )}
      {installOpen && <InstallSkillDialog agentName={agentName} installedNames={agent.skillNames} onClose={() => setInstallOpen(false)} />}
      {openSkill && (
        <AgentSkillModal
          agentName={agentName}
          skill={openSkill}
          content={skills.find((s) => s.name === openSkill)?.content ?? null}
          onClose={() => setOpenSkill(null)}
        />
      )}
    </section>
  );
}

// Unified skill popup for an agent skill: SKILL.md (editable) + the lazily-loaded
// sub-file tree (refs), via the shared SkillFilesModal — the same component the
// marketplace uses. Refs are fetched only when the skill opens (kept out of
// byName's recurring payload).
function AgentSkillModal({ agentName, skill, content, onClose }: { agentName: string; skill: string; content: string | null; onClose: () => void }) {
  const refsQ = trpc.agents.skillRefs.useQuery({ name: agentName, skill });
  const save = trpc.agents.requestEdit.useMutation();
  const items: SkillFileItem[] = [
    {
      key: 'SKILL.md',
      label: 'SKILL.md',
      body: content,
      monoLabel: true,
      onSave: (c) => save.mutateAsync({ name: agentName, target: `skill:${skill}`, content: c }),
    },
    ...(refsQ.data ?? []).map((r, i) => ({
      key: `ref-${i}-${r.path}`,
      label: r.path,
      body: r.content,
      monoLabel: true,
    })),
  ];
  return (
    <SkillFilesModal
      title={`${skill}/`}
      subtitle={`${agentName} · .claude/skills/${skill}`}
      items={items}
      loading={refsQ.isFetching && !refsQ.data}
      onClose={onClose}
    />
  );
}

// ── Identity / User / Workspace / Tools / Evolution / Memory (list → modal) ──

type FolderFile = { path: string; content: string | null };

// Condense this agent into a reusable marketplace template (strips private bits).
function TemplatePublishSection({ agentName }: { agentName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="pt-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <Package className="h-3.5 w-3.5" /> Publish as template
      </button>
      {open && <PublishTemplateDialog agentName={agentName} onClose={() => setOpen(false)} />}
    </section>
  );
}

function MarkdownSections({ agentName }: { agentName: string }) {
  // Profile texts are lazy now — byName carries names/metadata only. Fetch the
  // bodies once (long staleTime, NOT on byName's 30s/4s poll); shown collapsed.
  const texts = trpc.agents.coreTexts.useQuery({ name: agentName }, { staleTime: 5 * 60_000 });
  const coreItems: FileItem[] = [
    { key: 'identity', label: 'Identity', body: texts.data?.identityText ?? null, target: 'identity' },
    { key: 'user', label: 'User', body: texts.data?.userText ?? null, target: 'user' },
    { key: 'agents', label: 'Workspace rules', body: texts.data?.agentsText ?? null, target: 'agents' },
    { key: 'tools', label: 'Tools', body: texts.data?.toolsText ?? null, target: 'tools' },
  ];
  // Heavy folder trees come from a separate once-fetched query — NOT byName's 30s
  // refetch (keeps ~200KB of auto-memory JSON off the recurring payload).
  // Paths only — content is lazy-loaded per folder on expand (see FolderGroup),
  // so the sheet opens fast even for agents with a large memory corpus.
  const folders = trpc.agents.folders.useQuery({ name: agentName });
  const evolutionPaths = ((folders.data?.evolutionFiles ?? []) as Array<{ path: string }>).map((f) => f.path);
  const memoryPaths = ((folders.data?.memoryFiles ?? []) as Array<{ path: string }>).map((f) => f.path);
  return (
    <section className="space-y-2">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-1">files</h3>
      <FileList items={coreItems} agentName={agentName} />
      <FolderGroup label="evolution" scope="evolution" paths={evolutionPaths} agentName={agentName} editable />
      <FolderGroup label="memory" scope="memory" paths={memoryPaths} agentName={agentName} editable={false} note="Claude Code auto-memory · 只读" />
    </section>
  );
}

// A collapsible folder (evolution/ or memory/) whose sub-files open the same
// view/edit modal. Memory's items carry no edit target ⇒ read-only.
function FolderGroup({ label, scope, paths, agentName, note, editable }: {
  label: string; scope: 'evolution' | 'memory'; paths: string[]; agentName: string; note?: string; editable: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Fetch this folder's file content only once the user expands it — keeps the
  // detail sheet's initial open cheap (the path list comes from agents.folders).
  const content = trpc.agents.folderContent.useQuery(
    { name: agentName, scope },
    { enabled: open, staleTime: 60_000 },
  );
  if (paths.length === 0) return null;
  const byPath = new Map((content.data ?? []).map((f) => [f.path, f.content] as const));
  // evolution/ files are editable (target evolution/<path>); memory is Claude
  // Code's read-only auto-memory. body is null until the lazy fetch lands; while
  // it's in flight we show a "加载中…" line instead of the rows.
  const items: FileItem[] = paths.map((p) => ({
    key: `${scope}/${p}`,
    label: p,
    body: byPath.get(p) ?? null,
    target: editable ? `${scope}/${p}` : undefined,
    monoLabel: true,
    exists: true,
  }));
  return (
    <details
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="group rounded-lg border border-border bg-card"
    >
      <summary className="cursor-pointer list-none flex items-center gap-2 px-3 h-9 text-[12px]">
        <span className="font-mono text-foreground/85">{label}/</span>
        <span className="ml-auto flex items-center gap-2 shrink-0 text-muted-foreground tabular-nums">
          {paths.length} file{paths.length === 1 ? '' : 's'}
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <div className="border-t border-border px-2 py-2">
        {note && <p className="mb-1.5 px-1 text-[10px] text-muted-foreground/60">{note}</p>}
        {content.isFetching && !content.data ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground/60">加载中…</p>
        ) : (
          <FileList items={items} agentName={agentName} />
        )}
      </div>
    </details>
  );
}

// ── List row + detail modal ──────────────────────────────────────────────────
// Each markdown file / skill is a flat row; clicking opens a portal modal to read
// the rendered markdown and (when a write target is given) edit it. The edit
// pipeline is unchanged — Save → agents.requestEdit → gateway writes the file and
// re-syncs. Memory has no target ⇒ read-only. Bare createPortal (NOT base-ui
// Dialog) per the overlay-compositing gotcha; the detail only ever renders inside
// the inline /agents page (no Sheet) so there's no focus trap to fight.

type FileItem = {
  key: string;
  label: string;
  body: string | null;
  // A write target (identity | user | … | evolution/<path> | skill:<name>) makes
  // the modal editable. Omit for read-only (memory files).
  target?: string;
  monoLabel?: boolean;
  // The file exists but its content wasn't loaded (past the folder cap). Distinct
  // from an absent core file: shows "未加载" instead of "not present".
  exists?: boolean;
  // Self-evolved skill (SKILL.md frontmatter `source: evolution`) — shows a 🧬 badge.
  evolved?: boolean;
  // A market-publishable skill name → renders a trailing "upload to market" button.
  publishSkill?: string;
  // Marketplace binding status (skill items only): linked + whether a newer version exists.
  market?: { bound: boolean; hasUpdate: boolean; installedVersion: string; latestVersion: string | null; slug: string | null };
  // When set, clicking the row calls this instead of opening the inline modal —
  // routes skill rows to the unified SkillFilesModal (SKILL.md + full tree).
  onOpen?: () => void;
};

function fmtSize(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function FileList({ items, agentName }: { items: FileItem[]; agentName: string }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Derive the open item from the LIVE `items` each render so an edit + re-sync
  // refreshes the modal body, instead of pinning the snapshot from click time.
  const openItem = items.find((i) => i.key === openKey && i.body != null) ?? null;
  return (
    <>
      <div className="space-y-1.5">
        {items.map((it) => (
          <FileRow key={it.key} item={it} agentName={agentName} onClick={() => (it.onOpen ? it.onOpen() : setOpenKey(it.key))} />
        ))}
      </div>
      <DetailModal item={openItem} agentName={agentName} onClose={() => setOpenKey(null)} />
    </>
  );
}

function FileRow({ item, onClick, agentName }: { item: FileItem; onClick: () => void; agentName: string }) {
  if (!item.body) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded border border-dashed text-xs text-muted-foreground/60">
        <span className={cn('truncate', item.monoLabel ? 'font-mono' : 'uppercase tracking-wide')}>{item.label}</span>
        <span className="text-muted-foreground/40">{item.exists ? '— 未加载（太旧/超出上限）' : '— not present'}</span>
      </div>
    );
  }
  const inner = (
    <>
      <span className={cn('truncate text-sm text-foreground/90', item.monoLabel && 'font-mono text-[13px]')}>{item.label}</span>
      <span className="shrink-0 flex items-center gap-2">
        {item.market?.bound && (
          <span
            className="inline-flex items-center rounded border border-border/60 px-1 py-px text-[9px] font-mono text-muted-foreground/60"
            title={`linked to market · installed v${item.market.installedVersion}`}
          >
            🔗 v{item.market.installedVersion}
          </span>
        )}
        {item.evolved && (
          <span
            className="inline-flex items-center gap-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-px text-[10px] text-emerald-600 dark:text-emerald-400"
            title="self-evolved skill (frontmatter source: evolution)"
          >
            🧬 evolved
          </span>
        )}
        <span className="text-[11px] font-mono text-muted-foreground/60 tabular-nums">{fmtSize(item.body.length)}</span>
      </span>
    </>
  );
  const rowCls = 'flex items-center justify-between gap-2 px-3 py-2 rounded border bg-card hover:bg-accent/40 hover:border-foreground/30 transition-colors cursor-pointer text-left';
  // Skill rows get trailing market actions (pull-if-newer + upload), siblings — never nested.
  if (item.publishSkill) {
    const mk = item.market;
    return (
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onClick} className={cn('min-w-0 flex-1', rowCls)}>{inner}</button>
        {mk?.hasUpdate && mk.slug && <UpdateSkillButton agentName={agentName} slug={mk.slug} latest={mk.latestVersion ?? '?'} />}
        <PublishToMarketButton source="agent" agentName={agentName} skillName={item.publishSkill} />
        <UninstallSkillButton agentName={agentName} skillName={item.publishSkill} />
      </div>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cn('w-full', rowCls)}>{inner}</button>
  );
}

// Pull the latest market version of a bound skill into the agent (AgentRequest
// edit → gateway overwrites SKILL.md). Clears the "update available" prompt
// optimistically (the binding bumps now; the file content follows on next sync).
function UpdateSkillButton({ agentName, slug, latest }: { agentName: string; slug: string; latest: string }) {
  const utils = trpc.useUtils();
  const install = trpc.market.installToAgent.useMutation({
    onSuccess: () => {
      // Already-installed skill; the "update available" chip clears now (the
      // binding bump is synchronous), new content follows on the next sync.
      utils.market.agentSkillStatus.invalidate({ agentName });
      utils.agents.byName.invalidate({ name: agentName });
    },
  });
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="shrink-0 text-amber-500 hover:text-amber-600"
      title={`pull update → v${latest}`}
      aria-label="pull update from market"
      disabled={install.isPending}
      onClick={(e) => { e.stopPropagation(); install.mutate({ slug, agentName }); }}
    >
      <Download className="size-3.5" />
    </Button>
  );
}

// Remove a skill from the agent (delete-skill request → gateway rm's the dir) +
// drop any market binding. Works on any skill, not only market-installed ones.
function UninstallSkillButton({ agentName, skillName }: { agentName: string; skillName: string }) {
  const utils = trpc.useUtils();
  const confirm = useConfirm();
  const un = trpc.market.uninstallAgentSkill.useMutation({
    onSuccess: () => {
      // Drop it from the view immediately; the gateway rm's the dir + re-syncs
      // after. No polling — the cached agent reflects the removal now.
      utils.agents.byName.setData({ name: agentName }, removeAgentSkill(skillName));
      utils.market.agentSkillStatus.invalidate({ agentName });
    },
  });
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="shrink-0 text-muted-foreground hover:text-rose-500"
      title="uninstall skill"
      aria-label="uninstall skill"
      disabled={un.isPending}
      onClick={async (e) => {
        e.stopPropagation();
        if (await confirm({
          title: 'Uninstall skill',
          message: `Uninstall "${skillName}" from ${agentName}? Removes .claude/skills/${skillName}/.`,
          confirmLabel: 'Uninstall',
          danger: true,
        }))
          un.mutate({ agentName, skillName });
      }}
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}

function DetailModal({
  item,
  agentName,
  onClose,
}: {
  item: FileItem | null;
  agentName: string;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const utils = trpc.useUtils();
  const { scoped } = useScope();
  const editable = !!item?.target;

  const save = trpc.agents.requestEdit.useMutation({
    onSuccess: () => {
      utils.agents.byName.invalidate({ name: agentName });
      setEditing(false);
    },
  });
  const pending = trpc.agents.pendingRequests.useQuery(undefined, {
    enabled: !!item && editable && !scoped,
    // Adaptive (must match the other pendingRequests observers — RQ uses the min):
    // 2s while something's in flight, 12s idle. requestEdit invalidates on success.
    refetchInterval: (q) => (((q.state.data as unknown[] | undefined)?.length ?? 0) > 0 ? 2_000 : 12_000),
  });
  const isSaving =
    editable && (pending.data ?? []).some((p) => p.kind === 'edit' && p.agentName === agentName && p.target === item?.target);

  // Leave edit mode whenever the open file changes (or the modal closes).
  useEffect(() => {
    setEditing(false);
    setDraft('');
  }, [item?.key]);

  // Esc / backdrop cancel an in-progress edit first, else close (scroll-lock +
  // Esc/backdrop wiring live in <Overlay>).
  const interceptClose = useCallback(() => {
    if (editing) { setEditing(false); setDraft(''); return true; }
    return false;
  }, [editing]);

  if (!item || item.body == null) return null;
  const body = item.body;

  return (
    <Overlay
      onClose={onClose}
      z={100}
      interceptClose={interceptClose}
      panelClassName="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg border border-border bg-background shadow-xl"
    >
      {(close) => (
        <>
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 shrink-0">
          <span className={cn('text-sm font-medium truncate', item.monoLabel && 'font-mono')}>{item.label}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {isSaving && <span className="text-[10px] text-muted-foreground animate-pulse">saving…</span>}
            {editable && !editing && (
              <button
                type="button"
                onClick={() => { setDraft(body); setEditing(true); }}
                title={`edit ${item.label}`}
                aria-label={`edit ${item.label}`}
                className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              >
                <Pencil className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={close}
              aria-label="close"
              className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-4 py-3 text-sm">
          {editing ? (
            <div className="space-y-2">
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(32, Math.max(12, draft.split('\n').length + 1))}
                className="w-full font-mono text-[12px] leading-relaxed bg-background border border-border rounded-md px-2 py-1.5 outline-none focus:border-foreground/30 resize-y"
              />
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => item.target && save.mutate({ name: agentName, target: item.target, content: draft })}
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
                {!save.error && save.isSuccess && (
                  <span className="text-[11px] text-muted-foreground">queued — gateway writes the file then re-syncs.</span>
                )}
              </div>
            </div>
          ) : (
            <Markdown>{body}</Markdown>
          )}
        </div>
        </>
      )}
    </Overlay>
  );
}

