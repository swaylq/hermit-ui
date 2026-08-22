'use client';

// The three translation switches, stored on this device.
//
// Device-local rather than server-side on purpose: translation is a reading aid
// for whoever is holding the phone, not a property of the conversation. Nothing
// it produces is ever persisted or sent to an agent, so there is nothing for a
// second device to be consistent with.
//
// One JSON key rather than three string keys — the three are read together on
// every message row, and three `localStorage.getItem` calls per row per frame is
// a silly way to spend a render.
//
// `useSyncExternalStore` rather than useState + an effect, for the reason
// lib/session-view.ts gives: the server render and the first client render must
// agree or React reports a hydration mismatch, and the snapshot is the seam
// where that is settled once.

import { useSyncExternalStore } from 'react';

export type TranslatePrefs = {
  /** Master switch. Off means the feature is invisible: no button, no calls. */
  on: boolean;
  /** Translate incoming English replies into Chinese as they arrive. */
  autoIn: boolean;
  /** Translate outgoing Chinese into English before it is sent. */
  autoOut: boolean;
};

export const TRANSLATE_KEY = 'hermit:translate';
const EVENT = 'hermit:translate';

/**
 * Default OFF, including the master switch. This costs money per message and
 * changes what the agent receives; it does not get to turn itself on.
 */
export const DEFAULT_PREFS: TranslatePrefs = { on: false, autoIn: false, autoOut: false };

// The snapshot MUST be reference-stable between reads or useSyncExternalStore
// re-renders forever. So the parsed value is cached against the raw string it
// came from, and a read that finds the same string hands back the same object.
let cachedRaw: string | null = null;
let cachedVal: TranslatePrefs = DEFAULT_PREFS;

function parse(raw: string | null): TranslatePrefs {
  if (raw === cachedRaw) return cachedVal;
  let next = DEFAULT_PREFS;
  try {
    const o = raw ? (JSON.parse(raw) as Partial<TranslatePrefs>) : null;
    if (o && typeof o === 'object') {
      next = {
        on: o.on === true,
        autoIn: o.autoIn === true,
        autoOut: o.autoOut === true,
      };
    }
  } catch {
    // Corrupt or hand-edited — fall back rather than throwing inside a render.
  }
  cachedRaw = raw;
  cachedVal = next;
  return next;
}

export function readTranslatePrefs(): TranslatePrefs {
  try {
    return parse(localStorage.getItem(TRANSLATE_KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeTranslatePrefs(next: TranslatePrefs): void {
  try {
    localStorage.setItem(TRANSLATE_KEY, JSON.stringify(next));
  } catch {
    // private mode — the setting simply does not persist
  }
  // localStorage's own `storage` event does not fire in the tab that wrote it,
  // so same-tab listeners need this one. Cross-tab is covered by `storage`.
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* SSR */
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** Server snapshot: the defaults, so SSR and the first client paint agree. */
function serverSnapshot(): TranslatePrefs {
  return DEFAULT_PREFS;
}

export function useTranslatePrefs(): TranslatePrefs {
  return useSyncExternalStore(subscribe, readTranslatePrefs, serverSnapshot);
}

/** Test seam — the module-level snapshot cache outlives a single test. */
export function resetPrefsCache(): void {
  cachedRaw = null;
  cachedVal = DEFAULT_PREFS;
}
