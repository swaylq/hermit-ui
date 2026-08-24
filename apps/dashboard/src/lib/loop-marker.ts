// Is this message a loop ROUND REPORT — the closing line of one iteration of an
// in-conversation `/loop`?
//
// The loop skill mandates that every iteration ends with a marker line:
//
//   ↻ loop `<id8>` · run <N> — <one-line result>
//
// (see apps/cli/template/.claude/skills/loop/SKILL.md, "The iteration prompt").
// That line is a CONCLUSION by construction, not preamble — which is the whole
// reason this file exists. Two places need to tell it apart from ordinary
// chatter, and they must agree:
//
//   - the push pipeline, so a round report is delivered instead of being held
//     for half an hour and then replaced by whatever the agent said next;
//   - the status dot, so an unread round turns a session red rather than
//     leaving it amber behind a background task that may never end.
//
// TEXT BLOCKS ONLY. An assistant `tool_use` block routinely echoes the marker —
// the same iteration writes it into `.loop-state.json` and into the daily memory
// file — and counting those would double every round. chat.loopRuns' SQL guards
// the same way (it matches `"text": "` before the marker); this is that guard in
// TypeScript.

/**
 * The marker, anchored at the start of a LINE.
 *
 * Anchored so an inline mention ("the ↻ loop marker is what makes it
 * recognizable") is not a round, and scanned line-by-line rather than only at
 * the top because reports routinely carry a preamble above the marker
 * ("Done — … Final report:\n\n---\n\n↻ loop `x` · run 7 — …").
 *
 * Kept in step with parseLoopRun() in components/chat/loop-bar.tsx, which parses
 * the same line into its run number and summary for the loop card.
 */
export const LOOP_ROUND_LINE_RE = /^\s*↻\s*loop\b.*\brun\s*\d+/i;

/** Every text block of an Anthropic content array (or a bare string), in order. */
function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content as Array<{ type?: string; text?: string }>) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text);
  }
  return out;
}

/**
 * The round-marker line of a loop iteration report, or null if this message is
 * not one. Whitespace-collapsed and capped, so the caller can put it straight on
 * a lock screen.
 */
export function loopRoundLine(content: unknown, maxLen = 140): string | null {
  for (const text of textBlocks(content)) {
    for (const line of text.split('\n')) {
      if (!LOOP_ROUND_LINE_RE.test(line)) continue;
      const clean = line.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
      if (clean) return clean.slice(0, maxLen);
    }
  }
  return null;
}

/** Cheap boolean form for call sites that only need the fact. */
export function isLoopRound(content: unknown): boolean {
  return loopRoundLine(content) !== null;
}
