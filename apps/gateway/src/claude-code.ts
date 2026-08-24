// The Claude Code / Anthropic SDK transcript vocabulary + the small parsing
// predicates shared across the gateway (pane / session-snapshot / chat-runner /
// cron-runner). Centralizing them removes three near-identical copies of
// extractText and the hand-inlined tool_use / tool_result checks, and gives the
// event / block type strings one name instead of a bare literal scattered across a
// dozen comparisons. This is the transcript half of the "Claude Code contract"
// (docs/code-quality-backlog.md P1-3); the tmux-side half — pane names, resume
// prompts, the ~/.claude/projects path encoding — lives in @hermit-ui/tmux-driver.

// Transcript event `type` values (the top-level JSONL line's `type`).
export const CcEvent = {
  assistant: 'assistant',
  user: 'user',
  // Non-turn metadata: these bump the transcript mtime with no turn in flight.
  bridgeSession: 'bridge-session',
  summary: 'summary',
  fileHistorySnapshot: 'file-history-snapshot',
} as const;

// Content-block `type` values (inside `message.content[]`).
export const CcBlock = {
  text: 'text',
  toolUse: 'tool_use',
  toolResult: 'tool_result',
} as const;

// Event types that bump the transcript mtime but are NOT a turn — the freshness
// signal falls through to the authoritative pane marker for these, so a metadata
// write (e.g. a bridge-session on every dashboard/terminal reconnect) doesn't read
// as "working".
export const NON_TURN_EVENT_TYPES: ReadonlySet<string> = new Set([
  CcEvent.bridgeSession,
  CcEvent.summary,
  CcEvent.fileHistorySnapshot,
]);

export function isNonTurnEvent(type: unknown): boolean {
  return typeof type === 'string' && NON_TURN_EVENT_TYPES.has(type);
}

// Concatenate the text blocks of a message's `content` (a plain string passes
// through). Does NOT trim — callers that want a trimmed result call `.trim()`.
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === CcBlock.text && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

// Does this message `content` array contain a block of the given type?
function hasBlock(content: unknown, type: string): boolean {
  return Array.isArray(content) && content.some((b: any) => b?.type === type);
}
export const hasToolResult = (content: unknown): boolean => hasBlock(content, CcBlock.toolResult);
export const hasToolUse = (content: unknown): boolean => hasBlock(content, CcBlock.toolUse);

// ── CLI-injected turns ───────────────────────────────────────────────────────
//
// A `/loop` iteration is not sent by the dashboard. The loop skill schedules it
// with the CLI's own in-session CronCreate, and each fire enqueues the iteration
// prompt into claude's queue; it reaches the transcript as a `user` record with
// `isMeta: true`. A prompt the human typed has no `isMeta` — verified across a
// 9-hour session on 2026-08-24: 10 isMeta user records, all of them CLI
// injections (9 loop fires + the skill-load frame), 2 typed prompts and 9
// `<task-notification>` frames, none of them isMeta.
//
// That distinction is why the chat surface could show a loop's RESULTS and never
// the thing that caused them. Both transcript readers drop plain user prompts —
// correctly, since the dashboard already wrote the row when it accepted the
// message — but that reasoning only holds for a message the dashboard accepted.
// Nothing ever wrote a row for a turn the CLI injected, so the conversation read
// as an agent talking to itself once an hour (sway, 2026-08-24: "每次 loop 没有
// 发到对话框里").

/**
 * The one-line summary for a CLI-injected loop iteration, or null if this isn't
 * one.
 *
 * Deliberately narrow. It matches ONLY the loop skill's mandated iteration
 * prompt, not every `isMeta` frame: a skill-load preamble or a future injected
 * frame is machinery, and turning all of them into chat rows would trade a
 * missing row for a noisy one. `isMeta` alone is the discriminator for "the CLI
 * wrote this"; this phrase is the discriminator for "and it was a loop round".
 *
 * The phrase is ours — it comes from the iteration-prompt template in
 * apps/cli/template/.claude/skills/loop/SKILL.md, which mandates that every
 * iteration prompt contains it. Change one and change the other.
 */
const LOOP_ITERATION_RE = /this iteration of the loop:/i;

export function loopTriggerSummary(isMeta: unknown, content: unknown): string | null {
  if (isMeta !== true) return null;
  const text = extractText(content);
  const m = LOOP_ITERATION_RE.exec(text);
  if (!m) return null;
  // The task is the PARAGRAPH after the phrase. Stopping at the blank line
  // matters both ways: everything below it is the skill's boilerplate
  // (self-test, state file, report format), identical every round and worth
  // nothing to a reader — and a template that ever left the task empty would
  // otherwise hand back that boilerplate's first line as if it were the task,
  // which is a wrong row rather than a missing one.
  const task = text
    .slice(m.index + m[0].length)
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  return task ? task.slice(0, 160) : null;
}
