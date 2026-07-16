'use client';

// Brain · Persona — edit the orchestrator's decision-style / persona doc (PERSONA.md
// in its workspace). The brain reads it before dispatching + before answering a
// blocked agent; it tunes voice + caution WITHIN the absolute safety floor (it can
// never loosen the floor). Read/write go over the live file-manager bridge, same as
// the Files tab — no new backend. PERSONA.md is seeded write-once by the gateway.

import { useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { Button } from '@/components/ui/button';

const PERSONA_PATH = 'PERSONA.md';

function PersonaEditor({ agentName }: { agentName: string }) {
  const utils = trpc.useUtils();
  const q = trpc.fileManager.readText.useQuery({ agentName, path: PERSONA_PATH }, { retry: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = trpc.fileManager.writeText.useMutation({
    onSuccess: () => {
      utils.fileManager.readText.invalidate({ agentName, path: PERSONA_PATH });
      setDraft(null);
      setSaved(true);
    },
  });

  // A not-yet-seeded PERSONA.md readText-errors; treat it as a blank canvas so the
  // user can still write (saving creates it). Normally the gateway seeds it write-once.
  const serverText = q.data?.text ?? '';
  const value = draft ?? serverText;
  const dirty = draft != null && draft !== serverText;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 min-h-0 flex-col gap-3 p-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Your Brain’s editable decision-style &amp; persona. It’s read before every
        dispatch and before answering a blocked agent — shaping how work is handed out
        and how choices are made, <strong className="text-foreground/80">within</strong>{' '}
        the hard safety floor (destructive / irreversible / costly / uncertain always
        escalate to you). Markdown.
      </p>
      <textarea
        value={value}
        onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
        disabled={q.isPending}
        spellCheck={false}
        placeholder="# Persona & decision style…"
        className="flex-1 min-h-[300px] w-full rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-foreground/30 resize-none"
      />
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          disabled={save.isPending || q.isPending || !dirty}
          onClick={() => save.mutate({ agentName, path: PERSONA_PATH, text: value })}
        >
          {save.isPending ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Saving…</> : <><Save className="h-3.5 w-3.5 mr-1" /> Save</>}
        </Button>
        {save.error ? (
          <span className="text-xs text-rose-500">{save.error.message}</span>
        ) : dirty ? (
          <span className="text-xs text-muted-foreground">unsaved changes</span>
        ) : saved ? (
          <span className="text-xs text-emerald-500">Saved — the Brain picks it up on its next turn.</span>
        ) : null}
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/60">{value.length} chars</span>
      </div>
    </div>
  );
}

export default function BrainPersonaPage() {
  const agents = trpc.agents.list.useQuery(undefined, { refetchInterval: 30_000 });
  const brain = (agents.data ?? []).find((a) => a.isOrchestrator);
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span aria-hidden className="logo-crab-mono h-5 w-5 bg-foreground" />
        <span className="text-sm font-medium text-foreground">Brain · Persona</span>
      </header>
      {agents.isPending ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">loading…</div>
      ) : brain ? (
        <PersonaEditor key={brain.name} agentName={brain.name} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          No Brain yet — set one up from the Chat tab.
        </div>
      )}
    </div>
  );
}
