'use client';

import { trpc } from '@/lib/trpc';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { FileList, type FileItem } from '@/components/file-detail';

// Brain · Memory — a curated view of the brain's OWN memory: its roster, the
// per-agent dossiers, and the daily dreams (the brain writes these itself and
// keeps them terse via the dreaming ritual). Read from the synced auto-memory
// (agents.folderContent scope=memory); read-only here — Brain curates it. The raw
// workspace file manager is the separate Files tab (/brain/files).
type Mem = { path: string; content: string };

const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{children}</div>
);

export default function BrainMemoryPage() {
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 15_000 });
  const brain = (agents.data ?? []).find((a) => a.isOrchestrator);
  const memory = trpc.agents.folderContent.useQuery(
    { name: brain?.name ?? '', scope: 'memory' },
    { enabled: !!brain, refetchInterval: 15_000 },
  );
  const files = (memory.data ?? []) as Mem[];

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span aria-hidden className="logo-crab-mono h-5 w-5 bg-foreground" />
        <span className="text-sm font-medium text-foreground">Brain · Memory</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {agents.isPending ? (
          <Centered>loading…</Centered>
        ) : !brain ? (
          <Centered>No Brain yet — set one up from the Chat tab.</Centered>
        ) : memory.isPending ? (
          <Centered>loading…</Centered>
        ) : files.length === 0 ? (
          <Centered>Brain hasn&apos;t written any memory yet — it builds this as it works and dreams.</Centered>
        ) : (
          <MemoryBody files={files} />
        )}
      </div>
    </div>
  );
}

function MemoryBody({ files }: { files: Mem[] }) {
  const toItem = (f: Mem, label: string): FileItem => ({ key: f.path, label, body: f.content || null });
  const roster = files.filter((f) => f.path === 'roster.md' || f.path === 'MEMORY.md');
  const dossiers = files.filter((f) => /^agents\//i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  const dreams = files.filter((f) => /^dreams\//i.test(f.path)).sort((a, b) => b.path.localeCompare(a.path));
  const claimed = new Set([...roster, ...dossiers, ...dreams].map((f) => f.path));
  const other = files.filter((f) => !claimed.has(f.path)).sort((a, b) => a.path.localeCompare(b.path));

  const sections = [
    { title: 'Roster & index', items: roster.map((f) => toItem(f, f.path === 'roster.md' ? 'Roster' : 'Index · MEMORY.md')) },
    { title: 'Agent dossiers', items: dossiers.map((f) => toItem(f, f.path.replace(/^agents\//i, '').replace(/\.md$/i, ''))) },
    { title: 'Dreams', items: dreams.map((f) => toItem(f, f.path.replace(/^dreams\//i, '').replace(/\.md$/i, ''))) },
    { title: 'Other', items: other.map((f) => toItem(f, f.path)) },
  ].filter((s) => s.items.length > 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <p className="text-xs text-muted-foreground">
        Brain&apos;s own memory — its roster, per-agent dossiers, and daily dreams. Brain curates this
        itself (read-only here) and keeps it terse on purpose.
      </p>
      {sections.map((s) => (
        <section key={s.title} className="space-y-2">
          <div className="flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
            <span>{s.title}</span>
            <span className="tabular-nums text-muted-foreground/40">{s.items.length}</span>
          </div>
          <FileList items={s.items} />
        </section>
      ))}
    </div>
  );
}
