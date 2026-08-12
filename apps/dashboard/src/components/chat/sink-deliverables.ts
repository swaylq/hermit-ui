// Within one turn, the two things the user has to ACT on sink to the bottom:
// a delivered file below the prose that describes it, and a still-unanswered
// question card below that, hard against the composer. Everything else keeps
// its order.
//
// Why the agent can't just be told "attach last": attach_file POSTs its own
// chat row the instant the tool runs (gateway/src/mcp-stub.cjs:891), while the
// assistant text around it lands through a 120ms-debounced sync batch
// (gateway/src/chat-runner.ts:1257). So an attachment sent mid-turn sorts
// between the narration and the final reply, and when the debounce loses the
// race it sorts ABOVE the very sentence that introduced it. createdAt cannot
// express "last"; this pass can. Instructions still help — they make the
// common case already correct — but they can't be the guarantee.

import { isSameDay } from './lib';

export type Timelineish = {
  id: string;
  role: string;
  content: unknown;
  createdAt: Date | string;
  authoredBy?: string | null;
};

// attach_image renders inline and an image is usually part of the argument —
// a before/after screenshot belongs beside the paragraph that reads it, not in
// a pile at the bottom. A download chip is a pure deliverable, so it sinks.
// Flip to true to sink images too.
export const SINK_IMAGES = false;

// The MCP stub registers the tool as `mcp__hermit__ask` and codex-events
// renames its call to match, but the pi extension registers it under the BARE
// name `ask` (gateway/src/runtime/hermit-pi-extension.ts:333). Matching only
// the prefixed name left every pi/omp session with an un-anchored card: it kept
// its raw createdAt slot, which is above the question text, and a useless `ask`
// tool chip rendered next to it.
const ASK_TOOL_NAMES = new Set(['mcp__hermit__ask', 'hermit/ask', 'ask']);

export function isAskToolUse(b: unknown): boolean {
  const x = b as { type?: string; name?: string; input?: { question?: unknown } } | null;
  return (
    !!x &&
    x.type === 'tool_use' &&
    typeof x.name === 'string' &&
    ASK_TOOL_NAMES.has(x.name) &&
    typeof x.input?.question === 'string'
  );
}

const blocksOf = (m: Timelineish): any[] => (Array.isArray(m.content) ? (m.content as any[]) : []);

// A row posted by attach_file / attach_image: nothing but the optional caption
// text and the attachment itself. A plain prose row is all `text` and carries no
// attachment block, so it never matches.
const ATTACHMENT_BLOCK_TYPES = new Set(['text', 'image', 'file']);

export function isAttachmentRow(m: Timelineish): boolean {
  if (m.role !== 'assistant') return false;
  const blocks = blocksOf(m);
  if (blocks.length === 0) return false;
  if (!blocks.every((b) => b && typeof b === 'object' && ATTACHMENT_BLOCK_TYPES.has(b.type))) return false;
  return blocks.some((b) => b.type === 'file' || (SINK_IMAGES && b.type === 'image'));
}

// Rows that are blocking on a human: the assistant row hosting an unanswered
// `ask` (its card renders at that call site), or a standalone system card whose
// call site isn't in the window — permission prompts included. An ANSWERED card
// stays where it was asked; moving settled history around would only make an
// old conversation harder to follow.
export function isAwaitingUser(m: Timelineish, isPendingQuestion: (question: string) => boolean): boolean {
  return blocksOf(m).some((b) => {
    if (isAskToolUse(b)) return isPendingQuestion(b.input.question);
    return b?.type === 'interaction' && (b?.status ?? 'pending') === 'pending';
  });
}

// Reorder within each turn. A turn runs from one inbound `user` row to the next;
// a day rollover also closes one, so nothing is ever reordered across a date
// divider. Relative order inside each of the three buckets is preserved.
export function sinkDeliverables<T extends Timelineish>(
  messages: T[],
  isPendingQuestion: (question: string) => boolean = () => false,
): T[] {
  const out: T[] = [];
  let prose: T[] = [];
  let attachments: T[] = [];
  let awaiting: T[] = [];
  let dayAnchor: Date | string | null = null;

  const flush = () => {
    if (attachments.length || awaiting.length) out.push(...prose, ...attachments, ...awaiting);
    else out.push(...prose);
    prose = [];
    attachments = [];
    awaiting = [];
  };

  for (const m of messages) {
    if (m.role === 'user' || (dayAnchor && !isSameDay(dayAnchor, m.createdAt))) flush();
    dayAnchor = m.createdAt;
    if (m.role === 'user') {
      out.push(m);
      continue;
    }
    if (isAwaitingUser(m, isPendingQuestion)) awaiting.push(m);
    else if (isAttachmentRow(m)) attachments.push(m);
    else prose.push(m);
  }
  flush();
  return out;
}
