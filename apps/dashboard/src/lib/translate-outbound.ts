'use client';

// What you typed, for messages that went out in another language.
//
// When outgoing auto-translate is on, the row in the database is the English the
// agent received — that IS the message, and the transcript should say so. But
// the person who wrote it wrote Chinese, and a conversation where your own
// bubbles are in a language you did not use is unreadable. So the original is
// kept here, beside the timeline, and put back at render time.
//
// KEYED BY THE SENT TEXT, not by a message id. At the moment of sending there is
// no id yet — the optimistic row carries a temporary one and the real id arrives
// with the mutation response, after which SSE may re-push the row again. Keying
// by content means the lookup works for the optimistic row, the real row and any
// later re-render, with no reconciliation step to get wrong.
//
// Persisted, unlike the inbound cache: losing an inbound translation costs half
// a second to fetch again, whereas losing this one means your own message is
// stuck in English with no way back. Bounded hard, because it never expires on
// its own.

import { authedFetch } from '@/lib/asst-fetch';
import { shouldAutoTranslate } from '@/lib/translate-text';
import { translationUnavailable, markTranslationUnavailable } from '@/lib/translate-store';

const KEY = 'hermit:translate-sent';
/** Roughly a long session's worth of sent messages. */
const MAX_ENTRIES = 60;
/** A sent message can be 64k; storing that twice is not what this is for. */
const MAX_CHARS = 4_000;

type Entry = { sent: string; original: string };

// Read once, then kept in step by writes — `originalFor` runs on every user row
// of every render, and a localStorage read there would be a silly bill.
let loaded = false;
let map = new Map<string, string>();

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as Entry[]) : [];
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (e && typeof e.sent === 'string' && typeof e.original === 'string') map.set(e.sent, e.original);
      }
    }
  } catch {
    // Corrupt or unavailable (private mode) — start empty rather than throw.
  }
}

function persist(): void {
  try {
    const arr: Entry[] = [...map].map(([sent, original]) => ({ sent, original }));
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch {
    // Quota or private mode. The in-memory map still works for this page load,
    // which is the case that matters most — you just sent the thing.
  }
}

/** The Chinese behind a sent English message, if this device sent it. */
export function originalFor(sent: string): string | undefined {
  load();
  return map.get(sent.trim());
}

export function rememberOutbound(sent: string, original: string): void {
  const s = sent.trim();
  const o = original.trim();
  if (!s || !o || s === o) return;
  if (s.length > MAX_CHARS || o.length > MAX_CHARS) return;
  load();
  // Re-insert so it counts as newest (Map keeps insertion order).
  map.delete(s);
  map.set(s, o);
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  persist();
}

/**
 * Translate a message on its way out, and remember what it used to be.
 *
 * Returns the original on ANY failure — no key configured, a gate rejection, an
 * offline phone. A message that cannot be translated is still a message the
 * agent can read; refusing to send it would be a far worse trade.
 */
export async function translateOutgoing(sessionId: string, text: string): Promise<string> {
  if (!shouldAutoTranslate(text, 'en')) return text;
  // Shares the inbound latch: once the server has said it has no key, every
  // further send would otherwise pay a doomed round trip before going out.
  if (translationUnavailable()) return text;
  try {
    const r = await authedFetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // One block: an outgoing message is short, and cutting it up would risk
      // losing the thread between "first, …" and "then, …" across two calls.
      body: JSON.stringify({ sessionId, target: 'en', blocks: [text] }),
    });
    if (r.status === 503) {
      markTranslationUnavailable();
      return text;
    }
    if (!r.ok) return text;
    const { texts } = (await r.json()) as { texts?: Array<string | null> };
    const out = texts?.[0];
    if (typeof out !== 'string' || !out.trim() || out.trim() === text.trim()) return text;
    rememberOutbound(out, text);
    return out;
  } catch {
    return text;
  }
}

/** Test seam. */
export function resetOutbound(): void {
  loaded = false;
  map = new Map();
}
