'use client';

// Every 「说人话」 rewrite this browser is holding, and the fetch that gets the
// missing ones.
//
// Same three decisions as lib/translate-store.ts, for the same reasons — read
// that file's header for the long version:
//
//   · A SIDECAR, not a field on the message row. The chat cache replaces row
//     objects on every SSE push and projects an explicit column whitelist to
//     disk, so anything hung off a row is gone within 100ms or never reaches
//     IndexedDB.
//   · Keyed by the SOURCE TEXT, not the message id. The gateway retracts its
//     placeholder row mid-reply and lands the real one under a new id; keying by
//     id would throw the rewrite away at that moment.
//   · TWO TIERS. `getPlain` is called during render and cannot await, so the
//     memory map is the synchronous path and IndexedDB sits behind it — a key is
//     looked for on disk once per page load before it is ever paid for on the
//     network.
//
// Simpler than translations in one way: a rewrite is one request for one whole
// reply, fired because a person tapped a button. There is no batching, no
// coalescing window and no queue — at most a couple are ever in flight, because
// a person can only tap so fast.

import { plainKey } from '@/lib/plain-speak';
import { authedFetch } from '@/lib/asst-fetch';
import { currentScope, getTranslations, putTranslations, evictTranslationsLru } from '@/lib/chat-cache/db';

/** Whole replies rather than paragraphs, so the memory tier holds fewer. */
const MAX_ENTRIES = 200;

const done = new Map<string, string>();
/** Keys that came back refused or threw. Cleared by `retryPlain` on a re-tap. */
const failed = new Set<string>();
const inflight = new Set<string>();
/** Looked for on disk once per key per page load, before the network. */
const diskAsked = new Set<string>();

/**
 * Latched when the route answers 503 — the server has no OPENROUTER_API_KEY and
 * that will not change during this page load. Every later tap is answered from
 * memory instead of costing a doomed round trip.
 */
let notConfigured = false;
/** The LRU is checked once per page load, on the first write. */
let evictChecked = false;

const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version++;
  for (const l of listeners) l();
}

export function subscribePlain(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function plainVersion(): number {
  return version;
}

/** The rewrite of one reply, or undefined if it is not here (yet). */
export function getPlain(key: string): string | undefined {
  return done.get(key);
}

export function plainFailed(key: string): boolean {
  return failed.has(key);
}

/** True once the server has said it has no key. The UI says so and stops asking. */
export function plainUnavailable(): boolean {
  return notConfigured;
}

export function plainPending(key: string): boolean {
  return inflight.has(key);
}

function remember(key: string, text: string): void {
  // Insertion order — the oldest entry is the one furthest up a conversation
  // nobody is looking at any more.
  if (done.size >= MAX_ENTRIES) {
    const oldest = done.keys().next().value;
    if (oldest !== undefined) done.delete(oldest);
  }
  done.set(key, text);
}

/**
 * Ask for the plain-language version of one reply.
 *
 * Safe to call on every render: a key that is known, in flight or already
 * refused is dropped here.
 */
export function requestPlain(sessionId: string, text: string): void {
  if (notConfigured || !sessionId || !text.trim()) return;
  const key = plainKey(text);
  if (done.has(key) || failed.has(key) || inflight.has(key)) return;
  inflight.add(key);
  void run(key, sessionId, text);
}

/**
 * Forget a refusal so the next tap tries again. A failure here is usually the
 * network or a busy model, and the reader pressing the button a second time is
 * the clearest possible signal that they want it retried.
 */
export function retryPlain(text: string): void {
  const key = plainKey(text);
  if (failed.delete(key)) bump();
}

async function run(key: string, sessionId: string, text: string): Promise<void> {
  try {
    if (!diskAsked.has(key)) {
      diskAsked.add(key);
      const cached = await fromDisk(key);
      if (cached) {
        remember(key, cached);
        return;
      }
    }
    const r = await authedFetch('/api/plain-speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    });
    if (r.status === 503) {
      notConfigured = true;
      return;
    }
    if (!r.ok) {
      failed.add(key);
      return;
    }
    const { text: out } = (await r.json()) as { text?: string };
    if (typeof out === 'string' && out.trim()) {
      remember(key, out);
      // Write-through, off the render path: a failure costs one re-rewrite
      // after the next reload and nothing else, so it is never awaited.
      void persist(key, out);
    } else failed.add(key);
  } catch {
    // Offline, aborted, a parse failure — the original reply is still on screen.
    failed.add(key);
  } finally {
    inflight.delete(key);
    bump();
  }
}

async function fromDisk(key: string): Promise<string | undefined> {
  try {
    const scope = currentScope();
    if (!scope) return undefined;
    const hits = await getTranslations(scope, [key]);
    return hits.get(key);
  } catch {
    // No cache (private browsing, evicted, disabled) — straight to the network,
    // exactly as it behaved before this tier existed.
    return undefined;
  }
}

// The rewrites share the translations store rather than opening one of their
// own: they are the same kind of thing (derived text, keyed by its source, worth
// keeping but never authoritative), and sharing means signing out of a machine
// takes them along via pruneForeignScopes without any new bookkeeping. The `tag`
// in the key is what keeps the two namespaces apart.
async function persist(key: string, text: string): Promise<void> {
  try {
    const scope = currentScope();
    if (!scope) return;
    await putTranslations(scope, [{ key, text, lastUsedAt: Date.now() }]);
    if (!evictChecked) {
      evictChecked = true;
      await evictTranslationsLru(scope);
    }
  } catch {
    /* fails soft — the in-memory tier still serves this page load */
  }
}

/** Test seam. */
export function resetPlainSpeakStore(): void {
  done.clear();
  failed.clear();
  inflight.clear();
  diskAsked.clear();
  notConfigured = false;
  evictChecked = false;
  version = 0;
}
