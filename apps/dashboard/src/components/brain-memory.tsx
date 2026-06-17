'use client';

// Reads the brain's WORKSPACE memory/ folder (where it actually writes its
// roster / dossiers / dreams) over the live file-manager bridge, and renders it
// as a curated, lazily-expanded list. (The brain writes to its workspace memory/,
// not the Claude Code auto-memory, so this reads via fileManager — not
// agents.folderContent.) Each row lazy-loads its content on open, so a dir with
// 20 dossiers is one list call + a read only when you open a file.

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/markdown';

function MemoryFileRow({ agentName, path, label }: { agentName: string; path: string; label: string }) {
  const [open, setOpen] = useState(false);
  const q = trpc.fileManager.readText.useQuery({ agentName, path }, { enabled: open, retry: false });
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left cursor-pointer"
      >
        <span className="truncate font-mono text-[13px] text-foreground/90">{label}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5">
          {q.isPending ? (
            <span className="text-xs text-muted-foreground">loading…</span>
          ) : q.error ? (
            <span className="text-xs text-rose-500">{q.error.message}</span>
          ) : (
            <div className="text-sm">
              <Markdown>{q.data?.text ?? ''}</Markdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One section = the files directly under `dir` (folders are ignored), as a titled
// list of lazy rows. `labelOf` maps a filename to a friendlier label.
export function MemoryDir({
  agentName,
  dir,
  title,
  sortDesc = false,
  labelOf = (name) => name,
  emptyHint,
}: {
  agentName: string;
  dir: string;
  title: string;
  sortDesc?: boolean;
  labelOf?: (name: string) => string;
  emptyHint?: string;
}) {
  const listing = trpc.fileManager.list.useQuery({ agentName, path: dir }, { retry: false, refetchInterval: 15_000 });
  const files = (listing.data?.entries ?? [])
    .filter((e) => e.type === 'file')
    .sort((a, b) => (sortDesc ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        <span>{title}</span>
        <span className="tabular-nums text-muted-foreground/40">{files.length}</span>
      </div>
      {listing.isPending ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">loading…</p>
      ) : listing.error ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">{emptyHint ?? listing.error.message}</p>
      ) : files.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">{emptyHint ?? 'empty'}</p>
      ) : (
        <div className="space-y-1.5">
          {files.map((f) => (
            <MemoryFileRow key={f.name} agentName={agentName} path={`${dir}/${f.name}`} label={labelOf(f.name)} />
          ))}
        </div>
      )}
    </section>
  );
}
