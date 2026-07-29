'use client';

// How the chat sidebar arranges its sessions, plus which agent drawers are shut
// in the by-agent arrangement. Both are pure view state — no DB, no gateway — so
// they live in localStorage next to pins (session-pins.ts) and follow the same
// pattern: write, fire a `hermit:*` event, and every mounted reader re-renders
// (same tab via the custom event, other tabs via the native `storage` event).
//
// Why not the DB, when a manual group's collapsed flag IS in the DB: that flag is
// about a drawer someone made and named, and wanting it shut on the phone too. This
// is which lens you're looking through right now, and it should be free to differ
// between a laptop and a phone.
//
// useSyncExternalStore (rather than useState + effect) so the server/first-client
// render agrees on the defaults — the stored value lands on the next render, with
// no hydration mismatch and no setState-in-effect.

import { useSyncExternalStore } from 'react';

export type SessionView = 'recents' | 'agents';

const VIEW_KEY = 'hermit:chat-view';
const VIEW_EVENT = 'hermit:chat-view';
const COLLAPSED_KEY = 'hermit:chat-agent-collapsed';
const COLLAPSED_EVENT = 'hermit:chat-agent-collapsed';

function subscribeTo(event: string) {
  return (onChange: () => void) => {
    window.addEventListener(event, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(event, onChange);
      window.removeEventListener('storage', onChange);
    };
  };
}

// ── which view ────────────────────────────────────────────────────────────────

const subscribeView = subscribeTo(VIEW_EVENT);

function viewSnapshot(): SessionView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'agents' ? 'agents' : 'recents';
  } catch {
    return 'recents';
  }
}

/** The sidebar's current arrangement. 'recents' (the flat, recency-ordered list) is the default. */
export function useSessionView(): SessionView {
  return useSyncExternalStore(subscribeView, viewSnapshot, () => 'recents');
}

export function setSessionView(view: SessionView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // private mode / quota — the switch still works, it just won't persist.
  }
  window.dispatchEvent(new Event(VIEW_EVENT));
}

// ── which agent drawers are open ──────────────────────────────────────────────
//
// Only EXPLICIT choices are stored (name → open?), because "no entry" is not the
// same as "shut": an agent drawer defaults to shut, EXCEPT the one holding the
// session you currently have open. Recording just the clicks lets that default
// keep working for every agent you've never touched, while an agent you did shut
// stays shut even when you're reading one of its sessions.

const subscribeDrawers = subscribeTo(COLLAPSED_EVENT);

// useSyncExternalStore compares snapshots by identity, so parsing fresh on every
// call would re-render forever. Re-parse only when the stored string changed.
let cache: { raw: string | null; value: Record<string, boolean> } = { raw: null, value: {} };
const EMPTY: Record<string, boolean> = {};

function drawersSnapshot(): Record<string, boolean> {
  let raw: string | null;
  try {
    raw = localStorage.getItem(COLLAPSED_KEY);
  } catch {
    return EMPTY;
  }
  if (raw === cache.raw) return cache.value;
  let value = EMPTY;
  try {
    const obj: unknown = raw ? JSON.parse(raw) : {};
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      value = Object.fromEntries(
        Object.entries(obj as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean'),
      ) as Record<string, boolean>;
    }
  } catch {
    value = EMPTY;
  }
  cache = { raw, value };
  return value;
}

/**
 * Agent drawers the user has explicitly opened or shut. Empty during SSR and on
 * the first client render (see the module note), so the first paint shows the
 * defaults and the stored choices arrive on the next one.
 */
export function useAgentDrawers(): Record<string, boolean> {
  return useSyncExternalStore(subscribeDrawers, drawersSnapshot, () => EMPTY);
}

export function setAgentDrawer(name: string, open: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify({ ...drawersSnapshot(), [name]: open }));
  } catch {
    // as above — non-fatal
  }
  window.dispatchEvent(new Event(COLLAPSED_EVENT));
}
