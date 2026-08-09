'use client';

// The sidebar's "All agents" filter, remembered per machine.
//
// It stores an agent NAME, and agent names are machine-scoped — so the same
// reasoning as lib/last-session.ts applies: machine A's choice must never be
// applied while machine B is active. It used to live under one shared key, which
// meant switching workspaces carried the filter across and left the recents list
// filtering on an agent the new machine has never heard of. The list came back
// empty and the dropdown showed a stranger's name.
//
// sessionStorage, not localStorage: a filter is a scoping choice for THIS sitting,
// not something to inherit in a fresh tab a week later. That was true before and
// stays true; only the keying changes.

import { getActiveEntry } from '@/lib/keyring';

const KEY = 'hermit:chat-filter';

type Stored = Record<string, string>; // machine (keyring entry) id → agent name

function read(): Stored {
  if (typeof window === 'undefined') return {};
  try {
    const raw = sessionStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(
        ([m, a]) => typeof m === 'string' && typeof a === 'string' && a !== '',
      ),
    ) as Stored;
  } catch {
    return {};
  }
}

/** The active machine's remembered agent filter, or '' for "all agents". */
export function readChatFilter(): string {
  const machineId = getActiveEntry()?.id;
  if (!machineId) return '';
  return read()[machineId] ?? '';
}

/** Remember (or clear, with '') the filter for the active machine only. */
export function writeChatFilter(agentName: string): void {
  const machineId = getActiveEntry()?.id;
  if (!machineId) return;
  try {
    const next = read();
    if (agentName) next[machineId] = agentName;
    else delete next[machineId];
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode / quota — the filter just doesn't persist, which is the
    // behaviour before it was remembered at all.
  }
}
