'use client';

import { SettingsTabs } from '@/components/settings-tabs';
import { Card } from '@/components/ui/card';
import { SHORTCUTS, type ShortcutGroup } from '@/lib/shortcuts';
import { ShortcutKeys } from '@/components/keyboard-shortcuts';

const GROUPS: ShortcutGroup[] = ['Navigation', 'Actions', 'General'];

const GUIDE: { title: string; points: string[] }[] = [
  {
    title: 'Agents',
    points: [
      'Each agent is its own Claude Code instance with its own working directory, skills, and memory.',
      'Create or import agents in the Agents tab; open one to chat, browse its files, or get a terminal.',
    ],
  },
  {
    title: 'Chats & sessions',
    points: [
      "Every chat is a live Claude session running in a tmux pane on the agent's machine.",
      'Send while it is working and your messages queue, delivered oldest-first.',
      'The status dot shows green = idle, amber pulsing = working.',
    ],
  },
  {
    title: 'Session actions (right-click a chat)',
    points: [
      'Compact — summarize history to shrink the context window.',
      'Restart — kill the pane; your next message respawns it with full history (--resume).',
      'Hibernate (💤) — free its memory; it sleeps until you send, then wakes with history.',
      'Delete — remove the session and all its messages.',
    ],
  },
  {
    title: 'Host health',
    points: [
      'Settings → System shows the machine RAM, swap, load, and the memory each session uses.',
      'Idle sessions auto-hibernate past the configured TTL; hibernate the heaviest manually anytime.',
      'A red-pressure alert lands in Notifications when a machine runs critically low on memory.',
    ],
  },
  {
    title: 'Crons & loops',
    points: [
      'Cron schedules recurring tasks that survive restarts.',
      'Loops repeat a task inside a session and stream each round into the chat.',
    ],
  },
  {
    title: 'Files & secrets',
    points: [
      'Open an agent → Files to browse, upload, or download its working tree.',
      'Secrets are an encrypted, per-machine credential store that agents read via the secret CLI.',
    ],
  },
  {
    title: 'Notifications & Brain',
    points: [
      'The bell aggregates unread chats, finished cron runs, and host alerts for the machine.',
      'Brain is an optional orchestrator agent that delegates tasks to your other agents.',
    ],
  },
  {
    title: 'Machines',
    points: ['Switch machines from the sidebar footer; each runs its own gateway and agents.'],
  },
  {
    title: 'Install as an app',
    points: [
      'Install hermit-ui from your browser for a desktop / home-screen app — the keyboard shortcuts below are active in that installed window.',
    ],
  },
];

export default function HelpPage() {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <SettingsTabs active="help" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
          <div>
            <h2 className="mb-1 text-base font-semibold text-foreground">Using hermit-ui</h2>
            <p className="text-xs text-muted-foreground">
              A dashboard to chat with and manage your Claude agents across machines.
            </p>
          </div>

          <Card className="divide-y divide-border p-0">
            {GUIDE.map((s) => (
              <div key={s.title} className="p-4">
                <h3 className="mb-1.5 text-sm font-semibold text-foreground">{s.title}</h3>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {s.points.map((p, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="select-none text-muted-foreground/40">•</span>
                      <span className="[overflow-wrap:anywhere]">{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>

          <div>
            <h2 className="mb-1 text-base font-semibold text-foreground">Keyboard shortcuts</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Active in the installed app (PWA) on desktop; ignored while you are typing in a field. Press{' '}
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-mono">?</kbd> anywhere to pop this up.
            </p>
            <Card className="divide-y divide-border p-0">
              {GROUPS.map((g) => (
                <div key={g} className="p-4">
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g}</div>
                  <div className="space-y-1.5">
                    {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                      <div key={s.id} className="flex items-center justify-between gap-4 text-sm">
                        <span className="text-foreground/90">{s.label}</span>
                        <ShortcutKeys keys={s.keys} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
