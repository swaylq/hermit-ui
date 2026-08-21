// Folding a turn's machinery into one row.
//
// A single agent turn emits one assistant row per tool call and one user row per
// tool result, so a turn that reads six files and runs a build is ~15 timeline
// rows of which zero are things anyone said. Measured on this machine's DB:
// three quarters of all messages are pure tool traffic (a 26,874-message session
// held 5,779 rows with prose). Rendering them one-per-row is what makes the
// timeline read like a log file instead of a conversation, and it is most of
// what makes scrolling back through it expensive.
//
// So: everything a person can read stays a row of its own, and the machinery
// BETWEEN two such rows collapses into a single "run" — one capsule, expandable,
// carrying a live progress line while the turn is still going.
//
// Pure and synchronous; the React half is run-capsule.tsx.
//
// Folded away:  tool_use · tool_result · thinking
// Never folded: text · image · file · interaction · the `ask` tool_use
//               (that one IS the question card, not machinery)
//
// Order is preserved exactly. The unit is not the message but its BLOCKS: an
// assistant row of `[text, tool_use]` yields the prose row and then opens a run,
// and `[tool_use, text]` yields them the other way round. That is the only way
// "between two messages" can mean what it looks like it means when one message
// straddles the boundary.

import { isSameDay, isHarnessTerminator, type Block } from './lib';
import { isAskToolUse } from './sink-deliverables';

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
  /** Input arrived digested — the full arguments need a fetch. */
  d?: boolean;
};
export type ToolResultBlock = {
  type: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

export type RunStep =
  | { t: 'call'; call: ToolCall }
  | { t: 'result'; block: ToolResultBlock; d?: boolean }
  | { t: 'think'; text: string; chars: number };

export type FoldedMsg = {
  kind: 'msg';
  key: string;
  /** Every message id folded into this row — `data-msg-id` for search scroll. */
  ids: string[];
  role: string;
  authoredBy?: string | null;
  /** Visible blocks only; machinery has been lifted into the adjacent runs. */
  blocks: Block[];
  createdAt: Date | string;
  /** Source message id — what streaming-tail / typewriter decisions key on. */
  msgId: string;
};

export type FoldedRun = {
  kind: 'run';
  /**
   * Identity, and it is NOT the message that opened the run.
   *
   * A run is the machinery between two things a person said, so the obvious key
   * is the message that opened it — which is stable only while history grows
   * downward. "Load earlier" grows it upward: the loaded window began in the
   * middle of a turn's machinery, the rest of that turn arrives above, and the
   * run re-opens at an older message. The row whose identity would change is the
   * TOPMOST one — exactly the row under the reader's eyes at the moment they
   * triggered the load — and losing a row's key loses its measured height, the
   * windowing hook's own start anchor, and the DOM element itself. All three are
   * named in the notes on this subsystem as ways to lose the reading position,
   * and together they are what makes scrolling up jump.
   *
   * So a run is keyed by the row that FOLLOWS it. A closed run is bounded below
   * by a person-readable row that already exists; nothing arriving above or
   * below can change which row that is. The one run with nothing after it is the
   * one still being written, and it keeps a sentinel until it closes — a single
   * remount at the moment the capsule stops being a live progress line anyway.
   */
  key: string;
  ids: string[];
  steps: RunStep[];
  from: Date | string;
  to: Date | string;
};

/** Claude Code ended the turn with no reply — its own marker row. */
export type FoldedEnd = { kind: 'end'; key: string; ids: string[]; createdAt: Date | string };

export type FoldedRow = FoldedMsg | FoldedRun | FoldedEnd;

export type FoldInput = {
  id: string;
  role: string;
  content: unknown;
  createdAt: Date | string;
  authoredBy?: string | null;
};

const MACHINERY = new Set(['tool_use', 'tool_result', 'thinking']);

/**
 * True for a block the reader has no reason to see inline. `ask` is the one
 * tool_use that is exempt: the timeline swaps it for the interaction card at its
 * call site, so folding it away would swallow a question waiting on an answer.
 */
export function isMachineryBlock(b: unknown): boolean {
  const x = b as { type?: string } | null;
  if (!x || typeof x !== 'object' || typeof x.type !== 'string') return false;
  if (!MACHINERY.has(x.type)) return false;
  if (x.type === 'tool_use' && isAskToolUse(x)) return false;
  return true;
}

function blocksOf(content: unknown): Block[] {
  if (Array.isArray(content)) return content as Block[];
  if (typeof content === 'string' && content) return [{ type: 'text', text: content }];
  return [];
}

function stepFor(block: Block): RunStep | null {
  const b = block as Record<string, unknown>;
  const digested = b.__d ? true : undefined;
  if (b.type === 'tool_use') {
    return {
      t: 'call',
      call: { id: String(b.id ?? ''), name: String(b.name ?? '?'), input: b.input ?? {}, d: digested },
    };
  }
  if (b.type === 'tool_result') {
    return { t: 'result', block: block as ToolResultBlock, d: digested };
  }
  const text = String(b.thinking ?? b.text ?? '');
  // A digested thinking block carries its length in place of its body.
  const chars = typeof b.chars === 'number' ? b.chars : text.length;
  if (chars === 0) return null;
  return { t: 'think', text, chars };
}

/**
 * Fold a chronologically-ordered message list into timeline rows.
 *
 * Runs never span a day boundary — the timeline draws a date divider there, and
 * a capsule straddling one would have to be either above or below its own label.
 */
/**
 * Key of the run still being written — the only one with no row after it.
 *
 * A constant rather than a derived id: whatever it were derived from would be
 * the thing that keeps moving while the turn runs.
 */
export const OPEN_RUN_KEY = 'r-open';

export function foldRuns(messages: FoldInput[]): FoldedRow[] {
  const out: FoldedRow[] = [];
  let run: FoldedRun | null = null;
  let prevDay: Date | string | null = null;

  for (const m of messages) {
    if (prevDay && !isSameDay(prevDay, m.createdAt)) run = null;
    prevDay = m.createdAt;

    if (isHarnessTerminator(m.content)) {
      run = null;
      out.push({ kind: 'end', key: m.id, ids: [m.id], createdAt: m.createdAt });
      continue;
    }

    const blocks = blocksOf(m.content);
    let buf: Block[] = [];
    let part = 0;
    // A message of `[tool_use, text, tool_use]` opens TWO runs, and two rows
    // sharing a key would collide in React's reconciler and in the windowing
    // hook's measured-height map.
    let runPart = 0;
    const pushMsg = (visible: Block[]) => {
      run = null;
      out.push({
        kind: 'msg',
        key: part === 0 ? m.id : `${m.id}#${part}`,
        ids: [m.id],
        role: m.role,
        authoredBy: m.authoredBy,
        blocks: visible,
        createdAt: m.createdAt,
        msgId: m.id,
      });
      part += 1;
    };

    for (const b of blocks) {
      if (isMachineryBlock(b)) {
        if (buf.length > 0) {
          pushMsg(buf);
          buf = [];
        }
        const step = stepFor(b);
        if (!step) continue;
        if (!run) {
          const key = runPart === 0 ? `r-${m.id}` : `r-${m.id}#${runPart}`;
          runPart += 1;
          run = { kind: 'run', key, ids: [], steps: [], from: m.createdAt, to: m.createdAt };
          out.push(run);
        }
        run.steps.push(step);
        run.to = m.createdAt;
        if (run.ids[run.ids.length - 1] !== m.id) run.ids.push(m.id);
      } else {
        buf.push(b);
      }
    }

    if (buf.length > 0) pushMsg(buf);
    // An all-machinery message contributes no row of its own. An EMPTY one still
    // does — the old timeline rendered it, and dropping a row silently is how a
    // turn boundary goes missing.
    else if (blocks.length === 0 && part === 0) pushMsg([]);
  }

  // Second pass: name each run after the row below it (see FoldedRun.key). It
  // has to be a second pass because the follower is not known when the run
  // opens, and runs are never adjacent — a run is closed by the very row that
  // ends it — so no two runs can claim the same name.
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (r.kind !== 'run') continue;
    const next = out[i + 1];
    r.key = next ? `r>${next.key}` : OPEN_RUN_KEY;
  }

  return out;
}

// ── capsule summary ─────────────────────────────────────────────────────────
// What the COLLAPSED capsule shows. Derived here rather than inside the
// component so it is testable and the component stays a pure render.

export type RunSummary = {
  /** Distinct tool names, in first-call order. */
  names: string[];
  calls: number;
  errors: number;
  thinkChars: number;
  /** The most recent call — what "currently doing" reads off while running. */
  last: ToolCall | null;
  /** Some step arrived digested; expanding it needs a fetch. */
  digested: boolean;
};

export function summarizeRun(steps: RunStep[]): RunSummary {
  const names: string[] = [];
  let calls = 0;
  let errors = 0;
  let thinkChars = 0;
  let last: ToolCall | null = null;
  let digested = false;
  for (const s of steps) {
    if (s.t === 'call') {
      calls += 1;
      last = s.call;
      if (!names.includes(s.call.name)) names.push(s.call.name);
      if (s.call.d) digested = true;
    } else if (s.t === 'result') {
      if (s.block.is_error) errors += 1;
      if (s.d) digested = true;
    } else {
      thinkChars += s.chars;
      if (s.text === '' && s.chars > 0) digested = true;
    }
  }
  return { names, calls, errors, thinkChars, last, digested };
}
