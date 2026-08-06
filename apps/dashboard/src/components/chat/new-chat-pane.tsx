'use client';

// The "New chat" screen: pick an agent (or, for a scoped share session, locked to
// its one agent) and create a session. Extracted verbatim from chat/page.tsx
// (P2-3); behaviour identical. Consumed by ChatPageInner.

import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { SidebarMobileToggle } from '@/components/app-sidebar';
import { BackendPicker } from './backend-picker';
import { isRuntimeKind, type RuntimeKind } from '@/lib/runtime-labels';
import { PI_MODES, PI_MODE_META, DEFAULT_PI_MODE, isPiMode, type PiMode } from '@/lib/pi-modes';

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
  const [runtime, setRuntime] = useState<RuntimeKind | null>(null);
  const [model, setModel] = useState('');
  // pi only. Same "explicit choice or null" shape as `runtime`: null means the
  // agent's default, resolved at render once the agent lookup lands.
  const [mode, setMode] = useState<PiMode | null>(null);
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
    setModel('');
    setMode(null);
  }

  const chosen: RuntimeKind = runtime ?? (isRuntimeKind(agentRuntime) ? agentRuntime : 'claude-tmux');
  const chosenMode: PiMode = mode ?? (isPiMode(agentMode) ? agentMode : DEFAULT_PI_MODE);

  const create = trpc.chat.createSession.useMutation({ onSuccess: (s) => onCreated(s.id) });
  return (
    <div className="flex flex-1 flex-col">
      <header className="h-12 px-3 flex items-center gap-2 border-b border-border shrink-0">
        <SidebarMobileToggle />
        <span className="text-sm font-medium text-foreground">New chat</span>
      </header>
      <div className="flex-1 flex items-center justify-center p-6">
        <form
          className="w-full max-w-md rounded-2xl border border-border bg-card p-6 space-y-5 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (!agent) return;
            create.mutate({
              agentName: agent,
              runtime: chosen,
              ...(chosen === 'pi-rpc' && model.trim() ? { runtimeModel: model.trim() } : {}),
              // Written explicitly, for the same reason the backend is: a
              // session that states its mode keeps the one you started it in
              // when the agent's default is later edited.
              ...(chosen === 'pi-rpc' ? { runtimeMode: chosenMode } : {}),
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
              <Select value={agent} onValueChange={(v) => setPicked(v ?? '')} modal={false}>
                <SelectTrigger aria-label="select agent" className="mt-1.5 w-full py-2 text-sm font-mono">
                  <SelectValue>{(v: string | null) => (v ? v : (agents.length ? 'Pick an agent' : 'no agents found'))}</SelectValue>
                </SelectTrigger>
                <SelectContent className="font-mono">
                  {agents.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          )}
          <div className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Backend</span>
            <div className="mt-1.5">
              <BackendPicker value={chosen} onChange={setRuntime} agentDefault={agentRuntime ?? 'claude-tmux'} />
            </div>
          </div>
          {chosen === 'pi-rpc' && (
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
                  {PI_MODES.map((m) => <SelectItem key={m} value={m}>{PI_MODE_META[m].label}</SelectItem>)}
                </SelectContent>
              </Select>
              <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                {PI_MODE_META[chosenMode].blurb}
              </span>
            </label>
          )}
          {chosen === 'pi-rpc' && (
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Model</span>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="agent default"
                aria-label="pi model"
                className="mt-1.5 w-full text-sm font-mono"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Leave empty to use the agent&apos;s configured model.
              </span>
            </label>
          )}
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
  );
}
