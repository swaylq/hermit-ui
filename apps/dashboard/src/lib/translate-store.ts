'use client';

// The sidecar: every translation the browser is holding, and the queue that
// fetches the missing ones.
//
// SIDECAR, not a field on the message. Two mechanisms in the chat cache would
// eat a per-row property, both silently:
//
//   · applyMessagePush (lib/chat-cache/merge-messages.ts) decides a row is
//     unchanged by comparing role + JSON.stringify(content) and then REPLACES
//     the row object — anything hung off it is gone on the next SSE push, which
//     during a live reply is every 100ms.
//   · the IndexedDB write-through projects an explicit whitelist of columns
//     (lib/chat-cache/use-chat-cache.ts), so a new field never reaches disk.
//
// Keyed by BLOCK TEXT rather than message id, for a third reason: the gateway
// retracts its placeholder row mid-reply and lands the real one under a new id.
// Keying by id would throw away every translation bought so far at exactly the
// moment the reader is watching them accumulate. Keyed by content, a row swap
// is invisible — the same blocks hash to the same entries.
//
// In memory only. A reload re-translates what is on screen, which costs about
// ¥0.0007 per message and half a second; persisting it would mean a quota story
// on iOS and a staleness story here, for that.

import { blockKey, type Lang } from '@/lib/translate-text';
import { authedFetch } from '@/lib/asst-fetch';

/** Blocks in one HTTP request — must not exceed the route's own MAX_BLOCKS. */
const BATCH = 8;
/** Requests in flight at once. Two keeps a long reply moving without a burst. */
const MAX_CONCURRENT = 2;
/**
 * How long a batch waits for company. One tick of the reveal loop: long enough
 * that the blocks of one message land in one request, short enough to be
 * invisible next to a ~400ms translation.
 */
const COALESCE_MS = 40;
/** Paragraph-sized entries; this is a few hundred kB at worst. */
const MAX_ENTRIES = 800;

type Pending = { key: string; text: string; sessionId: string; target: Exclude<Lang, 'none'> };

const done = new Map<string, string>();
/** Keys that came back null or threw. Remembered so they are not retried forever. */
const failed = new Set<string>();
const inflight = new Set<string>();
const queue: Pending[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let running = 0;

/**
 * Latched when the route answers 503. The server has no key configured, and
 * that will not change during this page load — asking again for every message
 * would be a request per row for nothing.
 */
let notConfigured = false;

const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version++;
  for (const l of listeners) l();
}

export function subscribeTranslations(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function translationsVersion(): number {
  return version;
}

/** The translation of one block, or undefined if it is not here (yet). */
export function getTranslation(key: string): string | undefined {
  return done.get(key);
}

export function translationFailed(key: string): boolean {
  return failed.has(key);
}

export function translationUnavailable(): boolean {
  return notConfigured;
}

/**
 * Latch "the server has no key" from outside the queue. The outgoing path does
 * its own single-block request rather than going through the queue, and without
 * this it would pay a doomed round trip on every message the user sends.
 */
export function markTranslationUnavailable(): void {
  if (notConfigured) return;
  notConfigured = true;
  queue.length = 0;
  bump();
}

function remember(key: string, text: string): void {
  // Oldest-first eviction — Map preserves insertion order, and the oldest entry
  // is the one furthest up a conversation nobody is looking at any more.
  if (done.size >= MAX_ENTRIES) {
    const oldest = done.keys().next().value;
    if (oldest !== undefined) done.delete(oldest);
  }
  done.set(key, text);
}

/**
 * Ask for a set of blocks, in order. Already-known, already-queued, already-
 * failed and already-in-flight keys are dropped, so calling this on every
 * render is the intended usage.
 */
export function requestTranslations(
  sessionId: string,
  blocks: Array<{ key: string; text: string }>,
  target: Exclude<Lang, 'none'>,
): void {
  if (notConfigured) return;
  for (const b of blocks) {
    if (done.has(b.key) || failed.has(b.key) || inflight.has(b.key)) continue;
    if (queue.some((q) => q.key === b.key)) continue;
    queue.push({ key: b.key, text: b.text, sessionId, target });
  }
  schedule();
}

function schedule(): void {
  if (batchTimer || !queue.length) return;
  batchTimer = setTimeout(() => {
    batchTimer = null;
    void drain();
  }, COALESCE_MS);
}

async function drain(): Promise<void> {
  while (running < MAX_CONCURRENT && queue.length) {
    // One request carries one session and one direction; taking the head's
    // pair and filling from whatever else matches keeps FIFO order within a
    // message, which is what makes the reveal accumulate rather than fill in.
    const head = queue[0];
    const batch: Pending[] = [];
    for (let i = 0; i < queue.length && batch.length < BATCH; ) {
      const q = queue[i];
      if (q.sessionId === head.sessionId && q.target === head.target) {
        batch.push(q);
        queue.splice(i, 1);
      } else i++;
    }
    if (!batch.length) return;
    for (const b of batch) inflight.add(b.key);
    running++;
    void runBatch(batch).finally(() => {
      running--;
      for (const b of batch) inflight.delete(b.key);
      if (queue.length) schedule();
    });
  }
}

async function runBatch(batch: Pending[]): Promise<void> {
  try {
    const r = await authedFetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: batch[0].sessionId,
        target: batch[0].target,
        blocks: batch.map((b) => b.text),
      }),
    });
    if (r.status === 503) {
      notConfigured = true;
      queue.length = 0;
      bump();
      return;
    }
    if (!r.ok) {
      for (const b of batch) failed.add(b.key);
      bump();
      return;
    }
    const { texts } = (await r.json()) as { texts?: Array<string | null> };
    batch.forEach((b, i) => {
      const t = texts?.[i];
      if (typeof t === 'string' && t) remember(b.key, t);
      else failed.add(b.key);
    });
    bump();
  } catch {
    // Offline, aborted, a parse failure — the reader keeps the original text.
    for (const b of batch) failed.add(b.key);
    bump();
  }
}

/** Test seam. */
export function resetTranslationStore(): void {
  done.clear();
  failed.clear();
  inflight.clear();
  queue.length = 0;
  notConfigured = false;
  version = 0;
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
}

export { blockKey };
