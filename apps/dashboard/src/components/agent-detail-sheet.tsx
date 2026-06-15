'use client';

import { useCallback, useState, useEffect } from 'react';
import Link from 'next/link';
import { Pencil, Check, X, RotateCw, ChevronDown, Download, Trash2, Package } from 'lucide-react';
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
import { PublishToMarketButton } from './publish-to-market-button';
import { InstallSkillDialog } from './install-skill-dialog';
import { PublishTemplateDialog } from './publish-template-dialog';
import { Overlay } from './overlay';
import { SkillFilesModal } from './skill-files-modal';
import { type FileItem as SkillFileItem } from './file-detail';
import { sessionStatusView } from '@/lib/session-status';
import { isSessionUnread } from '@/lib/session-read';
import { removeAgentSkill } from '@/lib/optimistic-skills';

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
      <TemplatePublishSection agentName={name} />
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

              <TemplatePublishSection agentName={name} />
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
            const status = sessionStatusView(s, { unread: isSessionUnread(s) });
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
  // Per-skill SKILL.md contents come down on the agent sync (Agent.skills Json).
  // Falls back to a chip-only list if the gateway hasn't synced contents yet.
  const skills = ((agent as unknown as { skills?: Array<{ name: string; content: string }> }).skills) ?? [];
  const hasContent = skills.length > 0;
  // Marketplace binding status — which skills are linked + have a newer version.
  const status = trpc.market.agentSkillStatus.useQuery({ agentName }, { refetchInterval: 30_000 });
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

function MarkdownSections({ agent, agentName }: { agent: AgentByNameOutput['agent']; agentName: string }) {
  const coreItems: FileItem[] = [
    { key: 'identity', label: 'Identity', body: agent.identityText, target: 'identity' },
    { key: 'user', label: 'User', body: agent.userText, target: 'user' },
    { key: 'agents', label: 'Workspace rules', body: agent.agentsText, target: 'agents' },
    { key: 'tools', label: 'Tools', body: agent.toolsText, target: 'tools' },
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
      onClick={(e) => {
        e.stopPropagation();
        if (confirm(`Uninstall "${skillName}" from ${agentName}? Removes .claude/skills/${skillName}/.`)) un.mutate({ agentName, skillName });
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
  const editable = !!item?.target;

  const save = trpc.agents.requestEdit.useMutation({
    onSuccess: () => {
      utils.agents.byName.invalidate({ name: agentName });
      setEditing(false);
    },
  });
  const pending = trpc.agents.pendingRequests.useQuery(undefined, {
    enabled: !!item && editable,
    refetchInterval: !!item && editable ? 2_000 : false,
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

