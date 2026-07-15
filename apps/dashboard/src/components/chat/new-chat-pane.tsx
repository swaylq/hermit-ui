'use client';

// The "New chat" screen: pick an agent (or, for a scoped share session, locked to
// its one agent) and create a session. Extracted verbatim from chat/page.tsx
// (P2-3); behaviour identical. Consumed by ChatPageInner.

import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { SidebarMobileToggle } from '@/components/app-sidebar';

export function NewChatPane({ agents, preset, lockedAgent, onCreated, onCancel }: { agents: string[]; preset?: string; lockedAgent?: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState('');
  useEffect(() => {
    setPicked((cur) => cur || (preset && agents.includes(preset) ? preset : agents[0] ?? ''));
  }, [preset, agents]);
  // A scoped share session is locked to its one agent — no picker.
  const agent = lockedAgent ?? picked;
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
          onSubmit={(e) => { e.preventDefault(); if (agent) create.mutate({ agentName: agent }); }}
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
