'use client';

// Brain · Persona — the two documents that shape how the orchestrator behaves, side
// by side, because they answer different questions:
//
//   PERSONA.md — who the BRAIN is. Yours to edit. Voice, how it hands out work, how
//     cautious it is. Machine-managed content never touches this file.
//   USER-PROFILE.md    — who YOU are, as the Brain currently reads you. The Brain writes it
//     in its nightly dream from what you've actually typed; you read it and, if it
//     has you wrong, that's the signal to correct it.
//
// Keeping them in separate files is the whole point. A machine writing into the file
// a human edits is how you eat someone's prose — so the auto-updating summary lives
// next to the persona, not inside it.
//
// Both read/write over the live file-manager bridge, same as the Files tab.

import { useState } from 'react';
import { Loader2, RefreshCw, Save } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/markdown';

const PERSONA_PATH = 'PERSONA.md';
const USER_PROFILE_PATH = 'USER-PROFILE.md';

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
    <div className="flex flex-col gap-3 p-4 lg:min-h-0 lg:flex-1">
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
        className="h-[55vh] w-full shrink-0 rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-foreground/30 resize-none lg:h-auto lg:min-h-[300px] lg:shrink lg:flex-1"
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

// The Brain's read on the human. READ-ONLY here on purpose: the Brain rewrites this
// file every dream, so anything typed into it would be silently overwritten within a
// day — an edit box would be a promise the system can't keep. If it's wrong, the fix
// is to tell the Brain, not to patch its notes.
function UserProfileView({ agentName }: { agentName: string }) {
  const utils = trpc.useUtils();
  const q = trpc.fileManager.readText.useQuery({ agentName, path: USER_PROFILE_PATH }, { retry: false });
  const [asked, setAsked] = useState(false);
  const refresh = trpc.chat.requestUserProfileRefresh.useMutation({
    onSuccess: () => {
      setAsked(true);
      // The Brain has to actually run a turn before the file changes; refetch so a
      // manual reload isn't needed once it does.
      setTimeout(() => utils.fileManager.readText.invalidate({ agentName, path: USER_PROFILE_PATH }), 30_000);
    },
  });

  const text = q.data?.text ?? '';
  // Strip the machine watermark comment — it's bookkeeping for the Brain, noise here.
  const body = text.replace(/<!--\s*synced-through:[^>]*-->/g, '').trim();
  const syncedThrough = /<!--\s*synced-through:\s*([^>]*?)\s*-->/.exec(text)?.[1] ?? null;
  const never = !syncedThrough || syncedThrough === 'never';

  return (
    <div className="flex flex-col gap-3 p-4 lg:min-h-0 lg:flex-1">
      <p className="text-xs leading-relaxed text-muted-foreground">
        What your Brain has worked out about you — how you decide, how you like to be
        answered, and what you’re currently working on — from the messages you’ve
        actually typed. It refreshes in the nightly dream and is read before the Brain
        dispatches work or answers on your behalf.{' '}
        <strong className="text-foreground/80">It never loosens the safety floor.</strong>
      </p>
      <div className="h-[55vh] shrink-0 overflow-auto rounded-md border border-border bg-background p-3 text-sm lg:h-auto lg:min-h-[300px] lg:shrink lg:flex-1">
        {q.isPending ? (
          <span className="text-xs text-muted-foreground">loading…</span>
        ) : body ? (
          <Markdown>{body}</Markdown>
        ) : (
          <span className="text-xs text-muted-foreground">
            Nothing yet — the Brain writes this on its next dream.
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? (
            <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Asking…</>
          ) : (
            <><RefreshCw className="mr-1 h-3.5 w-3.5" /> Regenerate</>
          )}
        </Button>
        {refresh.error ? (
          <span className="text-xs text-rose-500">{refresh.error.message}</span>
        ) : asked ? (
          <span className="text-xs text-emerald-500">Asked — the Brain updates it on its next turn.</span>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground/60">
          {never ? 'never synced' : `synced through ${syncedThrough}`}
        </span>
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
        // Side by side on a wide screen, stacked on a phone. Two panes rather than
        // two tabs so the contrast is visible at a glance: this is who the Brain is,
        // that is who it thinks you are.
        //
        // The two layouts need OPPOSITE scroll models, and conflating them is what
        // broke this on a phone. Wide: one row, each pane owns the full height and
        // scrolls inside itself. Narrow: the panes stack, so they can't both claim
        // the height — they take their natural size and the PAGE scrolls. (<html> is
        // overflow-hidden app-wide, so a page that doesn't declare a scroll container
        // doesn't scroll at all; it just overflows and paints on top of itself.)
        <div className="flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto lg:flex-row lg:divide-x lg:divide-y-0 lg:overflow-hidden">
          <section className="flex shrink-0 flex-col lg:min-h-0 lg:w-1/2 lg:shrink lg:flex-1">
            <h2 className="shrink-0 px-4 pt-4 text-sm font-medium">Persona</h2>
            <PersonaEditor key={`p-${brain.name}`} agentName={brain.name} />
          </section>
          <section className="flex shrink-0 flex-col lg:min-h-0 lg:w-1/2 lg:shrink lg:flex-1">
            <h2 className="shrink-0 px-4 pt-4 text-sm font-medium">What it’s learned about you</h2>
            <UserProfileView key={`u-${brain.name}`} agentName={brain.name} />
          </section>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          No Brain yet — set one up from the Chat tab.
        </div>
      )}
    </div>
  );
}
