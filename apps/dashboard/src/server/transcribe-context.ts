// What the conversation was just about — the context both halves of voice input
// have been missing.
//
// ASR and the polish model each hear a sentence with no idea what it is about,
// and both fail in the same direction: toward the common word. "把 rathole 的隧道
// 重启一下" comes back as "把 rat hole 的隧道…", "voxtral" as "沃克斯特罗", "改一下
// hermit 的 gateway" as "改一下 何米特 的 gateway" — every one of them a term the
// agent had written out in full two messages earlier. qwen3-asr-flash takes a
// system message precisely for this (定制化识别: background text biases
// recognition, no preprocessing required), and the polish model can only restore
// a misheard identifier if it has seen the identifier somewhere.
//
// So: feed it the recent conversation. The whole conversation is out of the
// question — a single turn can be 100 rows of tool traffic and megabytes of
// thinking — and it would be the wrong text anyway. What a person's next
// sentence follows on from is what the agent SAID, not how it got there.
//
// THE FINAL REPLY. Claude Code writes one row per SDK event, and text and
// tool_use land in SEPARATE rows (measured on a live transcript: 585 tool_use,
// 203 thinking, 36 text, 1 mixed). So "the row has no tool_use" does not mean
// "this is the reply" — mid-turn narration ("Run 5。最高优先级未勾选…") looks
// exactly the same. What separates them is position: the reply is the text after
// the LAST tool call of the turn. Walking a turn backwards, that is the text you
// meet before the first tool row — everything past it is process. On a 642-turn
// transcript this drops 16 text rows to the 980-char reply the user actually
// read, every time.
//
// The scan is bounded (SCAN_ROWS) and the output is bounded twice more (per item
// and in total), because this runs in the latency path of every utterance: the
// user is holding a button, waiting for their words.

/**
 * Just enough of a Prisma client to run the scan — passed in rather than imported.
 *
 * This module is reached from two very different runtimes: the app-router route
 * (`@/server/db` resolves fine) and `server.ts`, which runs under tsx where the
 * `@/` alias does NOT resolve — importing `./db` here would crash the whole
 * server at boot the moment the realtime ASR socket pulled this in. So the caller
 * brings its own client and this file stays runtime-agnostic.
 */
export interface ContextDb {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * One row from the scan, newest first. Projected in SQL — `texts` is the message's
 * text blocks only, so a megabyte of tool_result or thinking never leaves Postgres.
 */
export interface ContextRow {
  role: string;
  /** `externalId IS NULL` — a message composed in the dashboard (human or Brain), as opposed to a gateway-synced row (assistant output, tool_result). */
  composed: boolean;
  texts: unknown[];
  hasTool: boolean;
}

/** A line of conversation worth showing the models. */
export interface ContextItem {
  who: 'user' | 'agent';
  text: string;
}

/**
 * How far back to look for finished replies.
 *
 * Measured on the 16 most recently active production sessions: at 40 or 120 rows,
 * 14 of 16 yield context — the two that don't are mid-turn, with their last human
 * message 135 and 213 rows back under a wall of tool traffic. Those are exactly
 * the moments someone talks to a busy agent, so the depth is set past them: at 240
 * all 16 yield, and 400 finds nothing more. Costs 1–2 ms and 801 bytes on the
 * busiest of them (the same rows unprojected would be 341 kB).
 */
export const SCAN_ROWS = 240;
/** How many agent replies to carry. Two exchanges is what a follow-on sentence refers back to; more is mostly older vocabulary. */
export const MAX_REPLIES = 3;
/** Total lines (user + agent) in the block. */
export const MAX_ITEMS = 6;
/** Per line. Agent replies run 700–1100 chars; the head carries the conclusion and the identifiers. */
export const MAX_ITEM_CHARS = 280;
/** Whole block. Bigger contexts are allowed by the API (qwen3-asr takes ~10k tokens) but every character is latency on a button-held-down interaction. */
export const MAX_TOTAL_CHARS = 900;

/**
 * Turn scanned rows (newest first) into conversation lines (oldest first).
 *
 * The walk is backwards, which is what makes "the final reply" cheap to find:
 * every composed message ENDS the turn before it, so crossing one puts us at the
 * end of a turn, collecting text until the first tool row closes it. Everything
 * before that in the turn is process, and is skipped without being read.
 */
export function pickContextItems(rows: ContextRow[]): ContextItem[] {
  const items: ContextItem[] = []; // newest first while we build
  let replies = 0;
  // 'tail' = at the end of a turn, its reply still being collected;
  // 'process' = past the turn's last tool call, nothing here is the reply.
  let where: 'tail' | 'process' = 'tail';
  let tail: string[] = [];

  const flushTail = () => {
    if (tail.length) {
      const text = clean(tail.join('\n'));
      if (text) {
        items.push({ who: 'agent', text });
        replies++;
      }
      tail = [];
    }
  };

  for (const row of rows) {
    if (row.role === 'user' && row.composed) {
      // A message somebody typed — and the boundary that ends the previous turn.
      flushTail();
      const text = clean(joinTexts(row.texts));
      if (text) items.push({ who: 'user', text });
      where = 'tail';
      if (replies >= MAX_REPLIES || items.length >= MAX_ITEMS) break;
      continue;
    }
    if (where === 'process') continue;
    // A tool_result (role 'user' in Anthropic's format, synced by the gateway) or
    // an assistant row that called a tool: the turn's output ends here.
    if (row.role !== 'assistant' || row.hasTool) {
      flushTail();
      where = 'process';
      if (replies >= MAX_REPLIES || items.length >= MAX_ITEMS) break;
      continue;
    }
    // Assistant text still inside the tail. Thinking-only rows project to no text
    // and pass through without closing anything, which is right — a reply is
    // often written as think-then-speak.
    const text = joinTexts(row.texts);
    if (text) tail.unshift(text);
  }
  flushTail();

  return items.slice(0, MAX_ITEMS).reverse();
}

/**
 * The context block handed to the models: oldest first, labelled, budget-capped.
 * Empty string when there is nothing to say — callers must then send no context
 * at all rather than an empty container, which reads as "the conversation is
 * empty" instead of "no context available".
 */
export function formatContext(items: ContextItem[]): string {
  const lines: string[] = [];
  let total = 0;
  // Newest lines matter most, so the budget is spent from the end backwards and
  // the result put back in order.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const text = truncate(item.text, MAX_ITEM_CHARS);
    const line = `${item.who === 'user' ? '用户' : '助手'}：${text}`;
    if (total + line.length > MAX_TOTAL_CHARS) break;
    total += line.length;
    lines.unshift(line);
  }
  return lines.join('\n');
}

/** Rows → the block, in one call. */
export function buildContext(rows: ContextRow[]): string {
  return formatContext(pickContextItems(rows));
}

/**
 * Read a session's recent conversation and shape it into the context block.
 *
 * The projection is the point of the raw query: `texts` and `hasTool` are computed
 * in Postgres, so 120 rows cross the wire as ~16 KB of prose instead of ~200 KB of
 * thinking blocks (measured on three real transcripts). The scan itself is an
 * index-backed backward walk on (sessionId, createdAt) — 0.7 ms for 120 rows on
 * the production DB.
 *
 * Never throws: context is an enhancement, and a transcription that fails because
 * a helper query hiccuped would be a strictly worse product than one with no
 * context at all.
 */
export async function loadContext(db: ContextDb, sessionId: string): Promise<string> {
  try {
    const rows = await db.$queryRaw<ContextRow[]>`
      SELECT role,
             ("externalId" IS NULL) AS composed,
             jsonb_path_query_array(content, '$[*] ? (@.type == "text").text') AS texts,
             jsonb_path_exists(content, '$[*] ? (@.type == "tool_use")') AS "hasTool"
      FROM "ChatMessage"
      WHERE "sessionId" = ${sessionId} AND role IN ('user', 'assistant')
      ORDER BY "createdAt" DESC
      LIMIT ${SCAN_ROWS}
    `;
    return buildContext(rows);
  } catch (e) {
    console.error('[transcribe] context load failed', e);
    return '';
  }
}

// A message's text blocks, as the SQL projection leaves them (JSON values, so a
// null `text` field is possible).
function joinTexts(texts: unknown[]): string {
  if (!Array.isArray(texts)) return '';
  return texts
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .join('\n')
    .trim();
}

/**
 * Prose the models can use, from markdown they can't.
 *
 * Fenced code blocks go: a pasted diff or JSON dump is the single easiest way to
 * spend the whole budget on text nobody spoke. INLINE code stays, backticks and
 * all — `rathole`, `voxtral`, `pm2 restart` are exactly the identifiers this
 * exists to put in front of the models.
 */
function clean(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ── the echo guard ──────────────────────────────────────────────────────────
//
// Context conditioning has one spectacular failure mode, and it is not
// hypothetical — it reproduced on the live qwen3-asr-flash, three times out of
// three. Hand it 1.5 s of digital silence plus a context block and it transcribes
// THE CONTEXT: hold the mic without speaking and the composer fills with 200
// characters of the agent's own last reply. (Without context the same silence
// returns 「嗯。」 — junk, but harmless junk.)
//
// A prompt can't fix this; there is no prompt, only audio and background text. So
// the guard is structural, and it is measured against the shape of the failure:
// an echo is a LONG verbatim run of the context, while speech that happens to
// overlap it is short (「rathole」, 「pm2 restart hermit-ui-gateway」 — 7 and 25
// normalized characters). Forty is comfortably above anything a person dictates
// verbatim and far below the ~200-character copies observed.

/** Longest verbatim run (normalized) that a transcript may share with the context. */
const ECHO_MIN_RUN = 40;
/** …and how much of the transcript that run has to be before it stops being a quote and starts being a copy. */
const ECHO_COVERAGE = 0.6;

/**
 * Did the ASR transcribe the context instead of the audio? Callers should redo
 * the request without context rather than hand this to the user.
 */
export function isContextEcho(transcript: string, context: string): boolean {
  const a = normalizeForEcho(transcript);
  const b = normalizeForEcho(context);
  if (a.length < ECHO_MIN_RUN || !b) return false;
  const run = longestCommonRun(a, b);
  return run >= ECHO_MIN_RUN && run >= a.length * ECHO_COVERAGE;
}

// Compare what was said, not how it was punctuated: the echo comes back with the
// model's own spacing and full-width punctuation.
function normalizeForEcho(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

// Longest common substring, two rows of DP. Both inputs are bounded (the context
// by MAX_TOTAL_CHARS, the transcript by a minute of speech), so this is a
// sub-millisecond scan on the sizes it actually sees.
function longestCommonRun(a: string, b: string): number {
  let best = 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) best = cur[j];
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return best;
}
