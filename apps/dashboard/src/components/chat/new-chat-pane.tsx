'use client';

// The "New chat" screen: pick an agent (or, for a scoped share session, locked to
// its one agent) and create a session. Extracted verbatim from chat/page.tsx
// (P2-3); behaviour identical. Consumed by ChatPageInner.

import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { SearchSelect } from '@/components/ui/search-select';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { BackendPicker } from './backend-picker';
import { effectiveDefaultBackendId, backendById } from '@/lib/backends';
import { PI_MODE_CHOICES, PI_MODE_META, DEFAULT_PI_MODE, isPiMode, type PiMode } from '@/lib/pi-modes';

export function NewChatPane({ agents, preset, lockedAgent, onCreated, onCancel }: { agents: string[]; preset?: string; lockedAgent?: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState('');
  // Which backend runs this session — always an explicit answer, never
  // "whatever the agent happens to default to at delivery time". There used to
  // be an "Agent default" option that wrote NULL; a session that states its own
  // backend keeps working the way you started it when the agent's default is
  // later edited, and it makes every header chip a fact rather than a lookup.
  //
  // Holds only an explicit choice; null = "the agent's default", resolved at
  // render. That way the picker is right the instant the agent lookup lands,
  // without a re-seed that would overwrite a choice made while it was in flight.
  const [runtime, setRuntime] = useState<string | null>(null);
  // pi only. Same "explicit choice or null" shape as `runtime`: null means the
  // agent's default, resolved at render once the agent lookup lands.
  const [mode, setMode] = useState<PiMode | null>(null);
  // Pure chat: a read-only child. Not derived from the agent, so it deliberately
  // survives switching agents — it describes what you want THIS conversation to
  // be, not who you are having it with.
  const [chatOnly, setChatOnly] = useState(false);
  useEffect(() => {
    setPicked((cur) => cur || (preset && agents.includes(preset) ? preset : agents[0] ?? ''));
  }, [preset, agents]);
  // A scoped share session is locked to its one agent — no picker.
  const agent = lockedAgent ?? picked;

  // The agent's own default, so the picker opens on it. One lookup per agent
  // choice, only on this screen — cheaper than putting `runtime` on the 10s
  // agents.list poll that every page runs.
  const agentMeta = trpc.agents.byName.useQuery({ name: agent }, { enabled: !!agent, staleTime: 60_000 });
  const agentRuntime = agentMeta.data?.agent.runtime;
  const agentMode = agentMeta.data?.agent.runtimeMode;

  // Switching agents drops the choice: the default belongs to the agent you are
  // about to talk to, not the one you looked at first. Adjusting state during
  // render rather than in an effect — see React's "you might not need an effect".
  const [pickedFor, setPickedFor] = useState('');
  if (pickedFor !== agent) {
    setPickedFor(agent);
    setRuntime(null);
    setMode(null);
  }

  // Which backends this machine offers, so the agent's default can be read
  // against them. Same query and staleTime as the picker's own — react-query
  // serves both from one request.
  const backends = trpc.machines.getBackendsConfig.useQuery(undefined, { staleTime: 60_000 });

  // The agent's default AS THIS MACHINE CAN RUN IT. An agent defaulting to a
  // backend switched off (or deleted) under Settings → Backends opens on the
  // first one the machine does offer — the same substitution the server applies
  // to an inherited default — rather than on an unclickable "off" card above a
  // Start button that would create a session nothing here can run.
  const agentBackend: string = effectiveDefaultBackendId(agentRuntime, backends.data);
  const chosen: string = runtime ?? agentBackend;
  // A mode is a pi spawn recipe, so the select only appears for a backend that
  // actually runs pi — which now depends on the backend the user composed, not
  // on the card's own name.
  const isPiBackend = backendById(backends.data, chosen)?.harness === 'pi-rpc';
  // Two backends need saying-so before you tick the box; both warnings sit
  // under it. prime cannot serve the mode by halves, and dsh/kimi have no
  // hermit tool surface, so they lose the one write tool the mode grants back.
  const chosenHarness = backendById(backends.data, chosen)?.harness;
  const isPrimeBackend = chosenHarness === 'prime-rpc';
  const hasNoHermitTools = chosenHarness === 'dsh-exec' || chosenHarness === 'kimi-code';
  const chosenMode: PiMode = mode ?? (isPiMode(agentMode) ? agentMode : DEFAULT_PI_MODE);

  const create = trpc.chat.createSession.useMutation({ onSuccess: (s) => onCreated(s.id) });
  return (
    // `min-h-0` HERE, not only on the scroll box below. This root is itself a
    // flex child of <main>, so its own default `min-height:auto` let it grow to
    // its content — measured at 1064px inside a 760px main — and the scroll
    // container then inherited a height taller than the screen with nothing
    // left to scroll. A scroll container is only a scroll container if every
    // flex ancestor between it and the bounded box can shrink.
    <div className="flex flex-1 flex-col min-h-0">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-medium text-foreground">New chat</span>
      </header>
      {/* Scrolls, and centres only when there is room to centre.

          Two separate faults lived in the one class list this replaces
          (`flex-1 flex items-center justify-center p-6`), and both needed the
          backend list to grow past a phone screen before they showed:

          · `flex-1` without `min-h-0`. A flex child's default `min-height:auto`
            refuses to shrink below its content, so the column grew to the
            card's full height instead of the viewport's — and since the app
            locks the root scroll (every view scrolls in its own container),
            there was nothing to scroll. The card simply ran off the bottom.

          · `items-center`. Centring an item TALLER than the line clips it at
            BOTH ends and the overflow is unreachable — you cannot scroll back
            up to it. `my-auto` is the fix rather than a different justify
            value: auto margins take the free space when there is some and
            collapse to zero when there is not, so the top edge is never eaten. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="flex min-h-full flex-col p-6">
        <form
          className="w-full max-w-md mx-auto my-auto rounded-2xl border border-border bg-card p-6 space-y-5 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (!agent) return;
            create.mutate({
              agentName: agent,
              runtime: chosen,
              // Written explicitly, for the same reason the backend is: a
              // session that states its mode keeps the one you started it in
              // when the agent's default is later edited.
              ...(isPiBackend ? { runtimeMode: chosenMode } : {}),
              ...(chatOnly ? { chatOnly: true } : {}),
            });
          }}
        >
          <div className="text-center space-y-2">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-foreground text-background flex items-center justify-center" aria-hidden="true">
              <Plus className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-medium tracking-tight text-foreground">Start a new chat</h2>
            <p className="text-xs text-muted-foreground">
              {lockedAgent ? <>with <span className="font-mono text-foreground/80">{lockedAgent}</span></> : 'Pick an agent to talk to.'}
            </p>
          </div>
          {!lockedAgent && (
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Agent</span>
              {/* Searchable: a fleet outgrows the length of list you can scan, and
                  by the time it does you already know the name you want. */}
              <SearchSelect
                value={agent}
                onValueChange={setPicked}
                items={agents}
                placeholder="Pick an agent"
                emptyPlaceholder="no agents found"
                searchPlaceholder="search agents"
                noMatchLabel="no agent matches"
                aria-label="select agent"
                className="mt-1.5 w-full py-2 text-sm font-mono"
                popupClassName="font-mono"
              />
            </label>
          )}
          <div className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Backend</span>
            <div className="mt-1.5">
              <BackendPicker value={chosen} onChange={setRuntime} agentDefault={agentBackend} />
            </div>
          </div>
          {isPiBackend && (
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Mode</span>
              <Select
                value={chosenMode}
                onValueChange={(v) => setMode(isPiMode(v) ? v : DEFAULT_PI_MODE)}
                modal={false}
              >
                <SelectTrigger aria-label="pi mode" className="mt-1.5 w-full py-2 text-sm">
                  <SelectValue>{(v: string | null) => PI_MODE_META[isPiMode(v) ? v : DEFAULT_PI_MODE].label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PI_MODE_CHOICES.map((m) => <SelectItem key={m} value={m}>{PI_MODE_META[m].label}</SelectItem>)}
                </SelectContent>
              </Select>
              <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                {PI_MODE_META[chosenMode].blurb}
              </span>
            </label>
          )}
          {/* Pure chat. Sits below the backend because what it means in practice
              depends on which one you picked — most notably for prime. */}
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={chatOnly}
              onChange={(e) => setChatOnly(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-foreground"
              aria-label="pure chat"
            />
            <span className="min-w-0">
              <span className="block text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Pure chat
              </span>
              <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                Read-only. It can look at files and search the web, but cannot write, edit, run
                commands or spawn sub-agents — so replies come back faster and nothing on disk
                changes. Memory is the one exception: it can still add to its own notes, and
                nothing it writes there can overwrite what is already recorded.
              </span>
              {chatOnly && hasNoHermitTools && (
                <span className="mt-1.5 block text-[11px] leading-relaxed text-amber-600 dark:text-amber-500">
                  This backend has no hermit tools, so pure chat also costs it the memory
                  exception: it can read and search, but whatever you work out together is gone
                  when the session ends.
                </span>
              )}
              {chatOnly && isPrimeBackend && (
                <span className="mt-1.5 block text-[11px] leading-relaxed text-amber-600 dark:text-amber-500">
                  prime can&apos;t do this by halves: its entire tool surface is one Python session,
                  where reading and writing happen in the same place. A pure-chat prime session
                  can talk and hand you files, but can&apos;t even read one. Pick another backend if
                  it needs to look things up.
                </span>
              )}
            </span>
          </label>
          {/* No model field here on purpose. Starting a chat should be: agent,
              backend, mode, go. The model comes from the backend's own default,
              then its credential's ("默认模型" under Settings → Models). This used to be a free-text
              box you had to leave blank on every single new chat — and for the
              same reason the session detail sheet no longer carries one either,
              so mode is the only pi dial in both places. */}
          <div className="flex gap-2">
            <Button type="submit" disabled={!agent || create.isPending} className="flex-1 h-10">
              {create.isPending ? 'creating…' : 'Start chat'}
            </Button>
            <Button type="button" variant="ghost" className="h-10" onClick={onCancel}>cancel</Button>
          </div>
          {create.error && <p className="text-xs text-rose-500">{create.error.message}</p>}
        </form>
        </div>
      </div>
    </div>
  );
}
