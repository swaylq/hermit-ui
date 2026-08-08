'use client';

// "Where was I?" — the chat this browser last had open, so reopening the
// dashboard drops you back into that conversation instead of whichever session
// happens to be newest. The chat page is URL-driven (`/chat?session=<id>`), so a
// refresh already keeps its place; this covers every path that arrives at a BARE
// `/chat`: a closed-and-reopened tab, an installed PWA relaunching at `start_url`,
// a phone waking the web app, and the reload the workspace switcher does after a
// machine switch.
//
// Keyed by the ACTIVE keyring entry's id, because session ids are machine-scoped:
// machine A's memory must never be restored while machine B is active (and an
// agent-share entry has its own id, so opening a share link can't clobber the
// owner's machine memory). The MACHINE half of "continue where I left off" is
// already handled by lib/keyring.ts — its active id mirrors to localStorage so a
// freshly-opened tab inherits the machine you last picked. This is the session half.
//
// localStorage, not sessionStorage: sessionStorage dies with the tab, which is
// exactly the case this exists to survive.

import { getActiveEntry, getKeyring } from '@/lib/keyring';

const KEY = 'hermit:last-session';

type Memory = Record<string, string>; // machine (keyring entry) id → session id

function read(): Memory {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    // Drop anything that isn't a plain id→id pair; the value is only ever read
    // back into a URL, so garbage in storage must not become garbage in the URL.
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(
        ([m, s]) => typeof m === 'string' && typeof s === 'string' && s !== '',
      ),
    ) as Memory;
  } catch {
    return {};
  }
}

/** Record the session the user is looking at on the active machine. */
export function rememberSession(sessionId: string): void {
  const machineId = getActiveEntry()?.id;
  if (!machineId || !sessionId) return;
  const cur = read();
  if (cur[machineId] === sessionId) return; // already stored — skip the write
  try {
    // Keep the other machines' slots, but only for machines still in the keyring,
    // so a workspace you removed doesn't leave its session id behind forever.
    const live = new Set(getKeyring().map((e) => e.id));
    const next: Memory = { [machineId]: sessionId };
    for (const [m, s] of Object.entries(cur)) if (m !== machineId && live.has(m)) next[m] = s;
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode / quota — the memory just doesn't stick; landing falls back
    // to the most recent session, which is what it did before this existed.
  }
}

/**
 * The session id this browser last had open on the ACTIVE machine, or null.
 * The caller must check the id against the session list before navigating to it:
 * the chat may have been deleted, hidden, or (in a share session) be out of scope.
 */
export function lastSessionId(): string | null {
  const machineId = getActiveEntry()?.id;
  if (!machineId) return null;
  return read()[machineId] ?? null;
}
