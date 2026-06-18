'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Boxes, Package, GitBranch, Plug, FileText, Trash2, Plus, Download, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { SettingsTabs } from '@/components/settings-tabs';
import { FileList, type FileItem } from '@/components/file-detail';
import { PublishToMarketButton } from '@/components/publish-to-market-button';
import { InstallSkillDialog } from '@/components/install-skill-dialog';

// ── source badge ──────────────────────────────────────────────────────────────
function SourceBadge({ source, isBundle }: { source: string; isBundle: boolean }) {
  const map: Record<string, { label: string; Icon: typeof FileText; cls: string }> = {
    manual: { label: 'manual', Icon: FileText, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/25' },
    git: { label: 'git', Icon: GitBranch, cls: 'text-sky-500 bg-sky-500/10 border-sky-500/25' },
    plugin: { label: 'plugin', Icon: Plug, cls: 'text-violet-500 bg-violet-500/10 border-violet-500/25' },
  };
  const m = map[source] ?? map.manual;
  const Icon = isBundle ? Package : m.Icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-mono uppercase tracking-wide', m.cls)}>
      <Icon className="size-2.5" /> {isBundle ? 'bundle' : m.label}
    </span>
  );
}

export default function SkillsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsTabs active="skills" />
      <SkillsPageInner />
    </Suspense>
  );
}

function SkillsPageInner() {
  const search = useSearchParams();
  const name = search.get('name');
  const showNew = !!search.get('new');
  const skills = trpc.skills.list.useQuery(undefined, { refetchInterval: 10_000 });

  if (showNew) return <NewSkillPane />;
  // Default (no skill selected): the global-skill LIST in the page (it used to
  // live in the sidebar). Clicking a row opens /skills?name=<name> → detail.
  if (!name) return <SkillsListView skills={skills.data ?? []} loading={skills.isPending} />;
  return <SkillDetail key={name} name={name} />;
}

// ── Skills list (default view) ────────────────────────────────────────────────
function SkillsListView({ skills, loading }: {
  skills: Array<{ id: string; name: string; description: string | null; source: string; isBundle: boolean; fileCount: number }>;
  loading: boolean;
}) {
  const [installOpen, setInstallOpen] = useState(false);
  return (
    <>
      <div className="px-4 py-2.5 flex items-center gap-2 shrink-0">
        <Button size="sm" variant="ghost" className="ml-auto gap-1 text-muted-foreground shrink-0" onClick={() => setInstallOpen(true)} title="install a skill from the market">
          <Download className="size-3.5" /> Install
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0 bg-background">
        <div className="px-4 py-4 max-w-3xl mx-auto">
          {loading ? (
            <div className="space-y-1.5">
              {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-14 rounded-lg bg-accent/40 animate-pulse" />)}
            </div>
          ) : skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-16 text-muted-foreground">
              <Boxes className="h-10 w-10 mb-3 opacity-30" aria-hidden="true" />
              <p className="text-sm">No global skills yet — start with “New skill”.</p>
              <p className="mt-1 text-xs">They live in <code className="font-mono">~/.claude/skills/</code> and are shared by every agent on this machine.</p>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {skills.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/skills?name=${encodeURIComponent(s.name)}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 hover:bg-accent/40 hover:border-foreground/30 transition-colors cursor-pointer"
                    title={s.description || s.name}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-sm text-foreground/90 truncate">{s.name}</span>
                        <SourceBadge source={s.source} isBundle={s.isBundle} />
                      </div>
                      {s.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{s.description}</p>}
                    </div>
                    <span className="shrink-0 text-[11px] font-mono text-muted-foreground/60 tabular-nums">
                      {s.fileCount} file{s.fileCount === 1 ? '' : 's'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>
      {installOpen && <InstallSkillDialog installedNames={skills.map((s) => s.name)} onClose={() => setInstallOpen(false)} />}
    </>
  );
}

// ── New skill ─────────────────────────────────────────────────────────────────
function NewSkillPane() {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="border-b border-border px-4 h-12 flex items-center gap-2 shrink-0">
        <span className="text-sm font-semibold text-foreground">New skill</span>
      </header>
      <ScrollArea className="flex-1 min-h-0 bg-background">
        <div className="px-4 py-8 flex justify-center">
          <NewSkillForm />
        </div>
      </ScrollArea>
    </div>
  );
}

function NewSkillForm() {
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');

  const create = trpc.skills.requestCreate.useMutation({
    onSuccess: (_row, vars) => {
      utils.skills.list.invalidate();
      utils.skills.pendingRequests.invalidate();
      // Hard navigation — a programmatic router.replace to a same-route query
      // change doesn't reliably navigate here (Next 16 + custom server).
      window.location.href = `/skills?name=${encodeURIComponent(vars.name)}`;
    },
  });

  const nameOk = /^[a-z][a-z0-9-]{0,40}$/.test(name);
  const canSubmit = nameOk && body.trim().length > 0 && !create.isPending;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const content = `---\nname: ${name}\ndescription: ${description.trim() || 'When should an agent use this skill?'}\n---\n\n${body.trim()}\n`;
    create.mutate({ name, content });
  }

  return (
    <form onSubmit={submit} className="w-full max-w-2xl rounded-2xl border border-border bg-card p-6 space-y-5 shadow-sm">
      <div className="text-center space-y-2">
        <div className="mx-auto h-12 w-12 rounded-2xl bg-foreground text-background flex items-center justify-center" aria-hidden="true">
          <Plus className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-medium tracking-tight text-foreground">New global skill</h2>
        <p className="text-xs text-muted-foreground">
          writes <code className="font-mono">~/.claude/skills/&lt;name&gt;/SKILL.md</code> on the gateway host — available to every agent.
        </p>
      </div>

      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Name</span>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="e.g. release-notes" className="mt-1.5 font-mono text-base sm:text-sm" autoFocus />
        <span className="text-[10px] text-muted-foreground/70">lowercase letter, then letters / digits / hyphens — becomes the directory name</span>
      </label>

      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Description</span>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="when should an agent reach for this skill?" className="mt-1.5 text-base sm:text-sm" />
        <span className="text-[10px] text-muted-foreground/70">the one-liner agents see when deciding whether to invoke it</span>
      </label>

      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Body (markdown)</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          placeholder={'# Skill\n\nSteps / knowledge the agent should follow when this applies.'}
          className="mt-1.5 w-full rounded-md border border-border bg-background p-2 font-mono text-[12px] outline-none focus:border-foreground/30 resize-y"
        />
        <span className="text-[10px] text-muted-foreground/70">frontmatter is generated from Name + Description above; this is the body</span>
      </label>

      {create.error && <p className="text-xs text-rose-500">{create.error.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={!canSubmit} className="flex-1 h-10">
          {create.isPending ? 'creating…' : 'Create skill'}
        </Button>
        <Button type="button" variant="ghost" className="h-10" onClick={() => { window.location.href = '/skills'; }}>cancel</Button>
      </div>
    </form>
  );
}

// ── Skill detail ──────────────────────────────────────────────────────────────
function SkillDetail({ name }: { name: string }) {
  const utils = trpc.useUtils();
  const q = trpc.skills.get.useQuery({ name }, { refetchInterval: 8_000 });
  // SKILL.md body + bundle ref files are split out of the 8s metadata poll —
  // fetched once (they only change on edit/pull, which invalidate this).
  const body = trpc.skills.content.useQuery({ name }, { staleTime: 5 * 60_000 });
  const update = trpc.skills.requestEdit.useMutation({
    onSuccess: () => { utils.skills.get.invalidate({ name }); utils.skills.content.invalidate({ name }); utils.skills.list.invalidate(); },
  });
  const del = trpc.skills.requestDelete.useMutation({
    onSuccess: () => { utils.skills.list.invalidate(); window.location.href = '/skills'; },
  });
  // Marketplace binding status for this machine skill + install/pull controls.
  const status = trpc.market.globalSkillStatus.useQuery();
  const pull = trpc.market.installToMachine.useMutation({
    onSuccess: () => { utils.skills.get.invalidate({ name }); utils.skills.content.invalidate({ name }); utils.skills.list.invalidate(); utils.market.globalSkillStatus.invalidate(); },
  });
  const [installOpen, setInstallOpen] = useState(false);
  const machineSkillNames = (trpc.skills.list.useQuery().data ?? []).map((s) => s.name);

  const skill = q.data?.skill;
  const mkt = status.data?.find((s) => s.name === name);

  if (q.isPending) return <div className="p-6"><div className="h-32 rounded-md bg-accent/40 animate-pulse" /></div>;
  if (!skill) {
    return (
      <>
        <header className="border-b border-border px-4 h-12 flex items-center gap-2 shrink-0">
          <span className="text-sm font-semibold">Skills</span>
        </header>
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Skill not found.</div>
      </>
    );
  }

  const refs = Array.isArray(body.data?.refs) ? (body.data.refs as Array<{ path?: string; name?: string; content: string }>) : [];

  // Every file in one list — click any to open the view/edit modal (mirrors the
  // agent detail). SKILL.md is editable on a manual skill; bundles (git/plugin)
  // and reference files are read-only (no onSave). Bundle content is null, so
  // SKILL.md only appears for real single skills.
  const files: FileItem[] = [];
  if (body.data?.content) {
    files.push({
      key: 'SKILL.md',
      label: 'SKILL.md',
      body: body.data.content,
      monoLabel: true,
      onSave: skill.isBundle ? undefined : (content) => update.mutateAsync({ name: skill.name, content }),
    });
  }
  refs.forEach((r, i) => {
    const label = r.path ?? r.name ?? `(file ${i + 1})`;
    files.push({ key: `ref:${label}-${i}`, label, body: r.content, monoLabel: true });
  });

  return (
    <>
      <header className="border-b border-border px-4 h-12 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Link href="/skills" title="back to skills" aria-label="back to skills" className="inline-flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground font-mono truncate">{skill.name}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground truncate">
              <SourceBadge source={skill.source} isBundle={skill.isBundle} />
              <span>{skill.fileCount} file{skill.fileCount === 1 ? '' : 's'}</span>
              {mkt && (
                <span className="inline-flex items-center rounded border border-border/60 px-1 py-px text-[9px]" title={`linked to market · installed v${mkt.installedVersion}`}>
                  🔗 v{mkt.installedVersion}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="ghost" className="gap-1 text-muted-foreground" onClick={() => setInstallOpen(true)} title="install a skill from the market">
            <Plus className="size-3.5" /> Install
          </Button>
          {mkt?.hasUpdate && mkt.slug && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="shrink-0 text-amber-500 hover:text-amber-600"
              title={`pull update → v${mkt.latestVersion}`}
              disabled={pull.isPending}
              onClick={() => pull.mutate({ slug: mkt.slug! })}
            >
              <Download className="size-3.5" />
            </Button>
          )}
          {!skill.isBundle && <PublishToMarketButton source="global" skillName={skill.name} />}
          {!skill.isBundle && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="shrink-0 text-muted-foreground hover:text-rose-500"
              disabled={del.isPending}
              onClick={() => { if (confirm(`Delete the global skill "${skill.name}"? This removes ~/.claude/skills/${skill.name}/.`)) del.mutate({ name: skill.name }); }}
              title="delete skill"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </header>

      <ScrollArea className="flex-1 min-h-0 bg-background">
        <div className="px-4 py-4 max-w-3xl mx-auto space-y-5">
          {skill.description && (
            <p className="text-[13px] text-foreground/80">{skill.description}</p>
          )}

          {skill.isBundle && (
            <section className="rounded-lg border border-border">
              <div className="px-3 h-9 flex items-center border-b border-border text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Bundle · {skill.subSkills.length} sub-skill{skill.subSkills.length === 1 ? '' : 's'}
              </div>
              <div className="p-3">
                <p className="text-xs text-muted-foreground mb-2">A git/plugin-managed skill framework — read-only here. Edit it at its source.</p>
                <ul className="flex flex-wrap gap-1.5">
                  {skill.subSkills.map((s) => (
                    <li key={s} className="rounded border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-foreground/85">{s}</li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {files.length > 0 && (
            <section>
              <div className="px-1 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                files · {files.length}
              </div>
              <FileList items={files} />
            </section>
          )}
        </div>
      </ScrollArea>
      {installOpen && <InstallSkillDialog installedNames={machineSkillNames} onClose={() => setInstallOpen(false)} />}
    </>
  );
}
