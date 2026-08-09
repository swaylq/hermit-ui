'use client';

// The "add agent" pane, lifted out of app/agents/page.tsx so it can be lazy()'d
// there. It renders ONLY behind `?new=1` / `?import=1`; the normal way into
// /agents is `?name=…` (or the default-landing redirect), which never shows it.
// As a static import its ~250 lines — two full forms plus the market template /
// skill pickers — sat in /agents' first-load script set, the heaviest route
// after /chat. Nothing here is referenced by the detail pane, so the split is a
// straight move: same markup, same behaviour, own chunk.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, FolderPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { SidebarMobileToggle } from '@/components/app-sidebar';

// Unified "add agent" pane: a segmented toggle switches the creation method
// between a fresh scaffold and importing an existing folder. Replaces the
// separate sidebar New / Import buttons — Import now lives here as a tab.
export function AddAgentPane({ initialMode, onClose }: { initialMode: 'new' | 'import'; onClose: () => void }) {
  const [mode, setMode] = useState<'new' | 'import'>(initialMode);
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-medium text-foreground">Add agent</span>
      </header>
      {/* Scroll the form when it's taller than the pane — the dashboard shell locks
          root scroll, so without this the Create button below the fold is unreachable.
          min-h-full keeps it vertically centered when the form DOES fit. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="min-h-full flex flex-col items-center justify-center gap-4 p-4 sm:p-6">
        <div role="tablist" aria-label="creation method" className="inline-flex rounded-lg border border-border bg-card p-0.5 text-[13px] font-medium">
          {([['new', 'New'], ['import', 'Import']] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'px-4 h-8 rounded-md transition-colors cursor-pointer',
                mode === m ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === 'new' ? <NewAgentForm onClose={onClose} /> : <ImportAgentForm onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}

function NewAgentForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [skillQuery, setSkillQuery] = useState('');
  const templates = trpc.market.listTemplates.useQuery();
  const marketSkills = trpc.market.listSkills.useQuery();
  const router = useRouter();
  const utils = trpc.useUtils();
  const create = trpc.agents.requestCreate.useMutation({
    onSuccess: (_, vars) => {
      utils.agents.list.invalidate();
      // Drop the user on the new agent's detail so they can watch it spin up.
      router.replace(`/agents?name=${encodeURIComponent(vars.name)}`);
    },
  });
  const nameOk = /^[a-z][a-z0-9-]{0,30}$/.test(name);
  const toggleSkill = (slug: string) =>
    setSkills((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));

  // Filter the market skill list by a case-insensitive match across name / slug /
  // description so a long market stays navigable when picking skills at create time.
  const skillList = marketSkills.data ?? [];
  const skillQ = skillQuery.trim().toLowerCase();
  const filteredSkills = skillQ
    ? skillList.filter(
        (s) =>
          (s.displayName || '').toLowerCase().includes(skillQ) ||
          s.slug.toLowerCase().includes(skillQ) ||
          (s.description || '').toLowerCase().includes(skillQ),
      )
    : skillList;

  return (
        <form
          className="w-full max-w-md rounded-2xl border border-border bg-card p-6 space-y-5 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (nameOk) create.mutate({ name, persona: persona.trim() || undefined, templateId: templateId || undefined, skills: skills.length ? skills : undefined });
          }}
        >
          <div className="text-center space-y-2">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-foreground text-background flex items-center justify-center" aria-hidden="true">
              <Plus className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-medium tracking-tight text-foreground">New agent</h2>
            <p className="text-xs text-muted-foreground">
              the gateway scaffolds it from the template; it shows up in the sidebar shortly.
            </p>
          </div>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Name</span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="e.g. scout"
              className="mt-1.5 font-mono text-base sm:text-sm"
              autoFocus
            />
            <span className="text-[10px] text-muted-foreground/70">lowercase letter, then letters / digits / hyphens</span>
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
              Function <span className="text-muted-foreground/60 normal-case">(optional)</span>
            </span>
            <Input
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder="leave blank — the agent will figure it out from its name"
              className="mt-1.5 text-base sm:text-sm"
            />
          </label>
          {(templates.data?.length ?? 0) > 0 && (
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Template <span className="text-muted-foreground/60 normal-case">(optional)</span>
              </span>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="mt-1.5 w-full h-10 sm:h-9 rounded-md border border-border bg-background px-2 text-base sm:text-sm cursor-pointer"
              >
                <option value="">Built-in (default)</option>
                {(templates.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>{t.displayName} · v{t.latestVersion}</option>
                ))}
              </select>
              <span className="text-[10px] text-muted-foreground/70">从市场模板新建会套用它的 identity / 工作区规则 / skills</span>
            </label>
          )}
          {skillList.length > 0 && (
            <div>
              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Skills from market <span className="text-muted-foreground/60 normal-case">(optional)</span>
                {skills.length > 0 && <span className="text-muted-foreground/60 normal-case"> · {skills.length} selected</span>}
              </span>
              {skillList.length > 5 && (
                <Input
                  value={skillQuery}
                  onChange={(e) => setSkillQuery(e.target.value)}
                  placeholder="Search skills…"
                  className="mt-1.5 h-9 text-base sm:text-sm"
                />
              )}
              <div className="mt-1.5 max-h-44 overflow-y-auto rounded-md border border-border divide-y divide-border">
                {filteredSkills.map((s) => (
                  <label key={s.slug} className="flex items-start gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-accent/40">
                    <input
                      type="checkbox"
                      checked={skills.includes(s.slug)}
                      onChange={() => toggleSkill(s.slug)}
                      className="mt-0.5 shrink-0 cursor-pointer accent-foreground"
                    />
                    <span className="min-w-0">
                      <span className="block font-mono text-sm text-foreground truncate">{s.displayName || s.slug}</span>
                      {s.description && <span className="block text-[11px] leading-snug text-muted-foreground line-clamp-2">{s.description}</span>}
                    </span>
                  </label>
                ))}
                {filteredSkills.length === 0 && (
                  <p className="px-2.5 py-3 text-[11px] text-muted-foreground/70">No skills match your search.</p>
                )}
              </div>
              <span className="text-[10px] text-muted-foreground/70">勾选的 skill 会装进新 agent 的 .claude/skills/（默认 skill 已含,无需勾）</span>
            </div>
          )}
          {create.error && <p className="text-xs text-rose-500">{create.error.message}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={!nameOk || create.isPending} className="flex-1 h-10">
              {create.isPending ? 'queuing…' : 'Create agent'}
            </Button>
            <Button type="button" variant="ghost" className="h-10" onClick={onClose}>cancel</Button>
          </div>
        </form>
  );
}

function ImportAgentForm({ onClose }: { onClose: () => void }) {
  const [directory, setDirectory] = useState('');
  const router = useRouter();
  const utils = trpc.useUtils();
  const importMut = trpc.agents.requestImport.useMutation({
    onSuccess: () => {
      utils.agents.list.invalidate();
      // After import lands the row will show in the sidebar — bounce to /agents
      // so the default-redirect picks the freshly-imported one (or first agent).
      router.replace('/agents');
    },
  });
  const trimmed = directory.trim();
  const valid = trimmed.startsWith('/') && trimmed.length >= 2 && trimmed.length <= 4096;

  const previewName = (() => {
    if (!trimmed) return '';
    const raw = trimmed.replace(/\/+$/, '').split('/').pop() || '';
    return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31);
  })();
  const previewOk = /^[a-z][a-z0-9-]{0,30}$/.test(previewName);

  return (
        <form
          className="w-full max-w-md rounded-2xl border border-border bg-card p-6 space-y-5 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && previewOk) importMut.mutate({ directory: trimmed });
          }}
        >
          <div className="text-center space-y-2">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-foreground text-background flex items-center justify-center" aria-hidden="true">
              <FolderPlus className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-medium tracking-tight text-foreground">Import existing agent</h2>
            <p className="text-xs text-muted-foreground">
              Register a folder on the gateway host as an agent. Its path is stored in the DB; your folder stays put.
            </p>
          </div>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Directory</span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <Input
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="/Users/you/some-agent"
              className="mt-1.5 font-mono text-base sm:text-sm"
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <span className="text-[10px] text-muted-foreground/70">
              absolute path on the gateway host. must contain <code className="font-mono">CLAUDE.md</code> at its root.
            </span>
          </label>
          {trimmed && previewOk && (
            <div className="text-[11px] text-muted-foreground">
              will appear as <span className="font-mono text-foreground">{previewName}</span>
            </div>
          )}
          {trimmed && !previewOk && (
            <div className="text-[11px] text-amber-600">
              basename <span className="font-mono">{previewName || '(empty)'}</span> isn&apos;t a valid agent name — pick a folder whose name starts with a letter and uses letters/digits/hyphens.
            </div>
          )}
          {importMut.error && <p className="text-xs text-rose-500">{importMut.error.message}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={!valid || !previewOk || importMut.isPending} className="flex-1 h-10">
              {importMut.isPending ? 'queuing…' : 'Import'}
            </Button>
            <Button type="button" variant="ghost" className="h-10" onClick={onClose}>cancel</Button>
          </div>
        </form>
  );
}
