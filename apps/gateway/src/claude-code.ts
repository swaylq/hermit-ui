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
