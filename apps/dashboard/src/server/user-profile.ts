// The corpus behind USER-PROFILE.md — the Brain's running read on how the human decides,
// how they talk, and what they're currently trying to get done.
// See docs/brain-takeover-design.md.
//
// The whole feature rests on one question being answered correctly: which rows are
// things the HUMAN actually typed? Get it wrong and the Brain summarises its own
// output, then acts on that summary, and every pass drifts further into a portrait
// of itself. So the filter is deliberately belt-and-braces:
//
//   role = 'user'          — assistant/tool/system rows aren't the human
//   authoredBy IS NULL     — excludes the Brain's takeover messages AND the
//                            gateway's `[dispatch update]` / `[takeover update]`
//                            pokes, which are role 'user' too
//   session.origin IS NULL — excludes whole dispatch conversations, every user row
//                            of which was written by the Brain
//   externalId IS NULL     — excludes transcript rows the gateway synced back: a
//                            tool_result, or an image the agent Read mid-task, is
//                            role 'user' in Anthropic's format (the same trap
//                            USER_QUEUE_FILTER exists for in routers/chat.ts)
//
// Three of those four are redundant with each other today. That's the point: each
// one alone has a failure mode, and a silent corpus leak is invisible until the
// Brain's behaviour has already drifted.

import { prisma } from './db';
import { extractSearchText } from './chat-text';

export interface HumanMessage {
  at: Date;
  agent: string;
  sessionId: string;
  text: string;
}

/** Hard ceiling per call, so one pass can't pull an unbounded slice into a prompt. */
export const HUMAN_MESSAGES_MAX = 400;

/** Longest single message kept. Past this it's a pasted log, not a preference. */
export const MAX_TEXT = 1200;

/** A row as the query returns it, before shaping. */
export interface CorpusRow {
  createdAt: Date;
  sessionId: string;
  content: unknown;
  session: { agentName: string };
}

/**
 * The query args — the corpus definition itself, extracted so the filter can be
 * asserted directly. Loosening any clause here is the failure mode described at the
 * top of this file, and it is invisible at runtime, so it gets a test rather than
 * only a comment.
 *
 * Oldest-first and cursor-shaped on purpose: the Brain folds each batch into the
 * existing USER-PROFILE.md and records a watermark, so a big backlog is absorbed over
 * several passes rather than truncated to "the most recent N" — which would keep
 * re-reading the same recent slice and never reach the rest.
 */
export function corpusQuery(machineId: string, opts: { since?: Date | null; limit?: number } = {}) {
  return {
    where: {
      role: 'user',
      authoredBy: null,
      externalId: null,
      ...(opts.since ? { createdAt: { gt: opts.since } } : {}),
      session: { machineId, origin: null },
    },
    select: {
      createdAt: true,
      sessionId: true,
      content: true,
      session: { select: { agentName: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(1, opts.limit ?? 200), HUMAN_MESSAGES_MAX),
  } as const;
}

/** Rows → the prose the Brain reads, dropping what carries no signal. */
export function shapeRows(rows: CorpusRow[]): HumanMessage[] {
  const out: HumanMessage[] = [];
  for (const r of rows) {
    const text = extractSearchText(r.content);
    // Image-only or attachment-only messages carry no preference signal.
    if (!text) continue;
    out.push({
      at: r.createdAt,
      agent: r.session.agentName,
      sessionId: r.sessionId,
      // Keep the HEAD of a long paste: the instruction is at the front, the pasted
      // payload behind it.
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    });
  }
  return out;
}

/** Everything the human typed on this machine after `since`, oldest first. */
export async function humanMessages(
  machineId: string,
  opts: { since?: Date | null; limit?: number } = {},
): Promise<HumanMessage[]> {
  return shapeRows(await prisma.chatMessage.findMany(corpusQuery(machineId, opts)));
}
