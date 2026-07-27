// Naming a chat session after what it is doing LATELY.
//
// The sidebar used to show the first user message (ChatSession.preview). That's
// the opening line — the setup, not the subject — and in a session that runs for
// days it stops describing anything you care about. What you want from the list
// is "what is this one working on right now", so that is what the title means
// here: a label over the RECENT end of the conversation, not a summary of the
// whole thing.
//
// Two consequences follow from that definition:
//   · read only the last few messages. The opening is deliberately NOT sampled;
//     including it would drag the title back toward whatever the session
//     started as, which is exactly the staleness we're trying to remove.
//   · refresh often. A stale title defeats the purpose, so the gate is a flat
//     "some new conversation has happened", not anything proportional — a long
//     session needs re-reading just as often as a short one, arguably more.
//
// Cost stays bounded because the trigger is OPENING a session, not message
// volume: however busy a session gets between visits, one visit costs at most
// one call, and revisiting with nothing new costs none.
//
// A title the USER typed is never touched — chat.setTitle marks the row
// `titleAuto = false` and that ends it. Failure is silent and leaves whatever
// was there; a missing title is cosmetic, never a broken session.

import { prisma } from './db';
import { extractSearchText } from './chat-text';
import { openrouterChat } from './openrouter';

const MODEL = process.env.OPENROUTER_TITLE_MODEL || 'deepseek/deepseek-v4-flash';
// How many recent messages with prose to show the model. A handful of exchanges
// is enough to say what's going on, and keeps the call small.
const SAMPLE_MESSAGES = 8;
const SAMPLE_CHARS = 2500;
export const TITLE_MAX = 40;
// New messages required before the title is re-derived. Most rows in a working
// session are tool traffic with no prose, so this is roughly a handful of real
// exchanges — recent enough to stay true, coarse enough that reopening a
// session you were just in costs nothing.
const REFRESH_AFTER_MESSAGES = 30;

const SYSTEM = [
  'You label an ongoing chat conversation with what it is CURRENTLY working on.',
  'You are shown only its most recent messages.',
  'Reply with ONLY the label: the specific task or topic in play, as a noun phrase.',
  // The USER's language, not the transcript's: a Chinese conversation quoting
  // English tool output was coming back with an English title, and it's the
  // user who reads the sidebar.
  'Write the label in the language the USER writes in, even when the excerpt quotes English code, logs or output.',
  'At most 20 characters for Chinese/Japanese/Korean, at most 6 words otherwise.',
  'No quotes, no trailing punctuation, no prefix like "标题:" or "Title:".',
  'Be concrete. "修复滚动跳变" not "技术讨论"; "Postgres index tuning" not "A question".',
].join(' ');

/** Strip the ways a model still occasionally wraps or prefixes its answer. */
export function cleanTitle(raw: string): string {
  let t = raw.trim().split('\n')[0].trim();
  t = t.replace(/^(标题|title)\s*[:：]\s*/i, '');
  t = t.replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '');
  t = t.replace(/[.。!！?？,，、;；]+$/g, '');
  t = t.trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) : t;
}

/** Has enough new conversation happened to be worth re-reading? */
export function shouldRefresh(previousCount: number | null, currentCount: number): boolean {
  if (previousCount == null) return true; // titled before we tracked counts
  return currentCount - previousCount >= REFRESH_AFTER_MESSAGES;
}

/**
 * Generate and store a title for `sessionId`.
 *
 * `generated` reports whether a model call actually happened, so callers — and
 * tests — can see the cost. `force` regenerates regardless: the manual button.
 */
export async function generateSessionTitle(
  sessionId: string,
  machineId: string,
  opts: { force?: boolean; scopedAgent?: string | null } = {}
): Promise<{ title: string | null; generated: boolean }> {
  const session = await prisma.chatSession.findFirst({
    where: {
      id: sessionId,
      machineId,
      ...(opts.scopedAgent ? { agentName: opts.scopedAgent } : {}),
    },
    select: { id: true, title: true, titleAuto: true, titleMsgCount: true },
  });
  if (!session) return { title: null, generated: false };

  // A name the user chose is final. Only an explicit `force` may override it.
  if (session.title && !session.titleAuto && !opts.force) {
    return { title: session.title, generated: false };
  }

  const count = await prisma.chatMessage.count({ where: { sessionId } });

  // Nothing meaningful has happened since we last looked. This is the common
  // path — no model call, no tokens.
  if (session.title && session.titleAuto && !opts.force && !shouldRefresh(session.titleMsgCount, count)) {
    return { title: session.title, generated: false };
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { title: session.title, generated: false };

  // The RECENT end, newest-first from the database. `take` is generous because
  // most rows carry no prose at all.
  const recent = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SAMPLE_MESSAGES * 6,
    select: { role: true, content: true },
  });

  const lines: string[] = [];
  let budget = SAMPLE_CHARS;
  for (const r of recent) {
    const text = extractSearchText(r.content);
    if (!text) continue;
    // Take the TAIL of a long message: the end of a turn is where it says what
    // it actually did; the beginning is preamble.
    const slice = text.length > 600 ? text.slice(-600) : text;
    const capped = slice.slice(0, Math.min(slice.length, budget));
    if (!capped) break;
    lines.push(`${r.role === 'user' ? 'User' : 'Assistant'}: ${capped}`);
    budget -= capped.length;
    if (lines.length >= SAMPLE_MESSAGES || budget <= 0) break;
  }
  // One line of prose is not a conversation; leave `preview` to do the job.
  if (lines.length === 0) return { title: session.title, generated: false };
  lines.reverse(); // oldest → newest, so the model reads it as a conversation

  let title: string;
  try {
    title = cleanTitle(
      await openrouterChat(
        key,
        MODEL,
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: lines.join('\n\n') },
        ],
        { temperature: 0.3, reasoningOff: true, timeoutMs: 20_000, title: 'hermit-ui session title' }
      )
    );
  } catch {
    return { title: session.title, generated: false };
  }
  if (!title) return { title: session.title, generated: false };

  // Guarded write. Two tabs opening the same session race here, and a manual
  // rename landing mid-flight must win: unless forcing, only claim the row if
  // it's still untitled or still ours.
  const res = await prisma.chatSession.updateMany({
    where: {
      id: sessionId,
      machineId,
      ...(opts.force ? {} : { OR: [{ title: null }, { titleAuto: true }] }),
    },
    data: { title, titleAuto: true, titleMsgCount: count },
  });
  if (res.count === 0) {
    const current = await prisma.chatSession.findUnique({ where: { id: sessionId }, select: { title: true } });
    return { title: current?.title ?? null, generated: false };
  }
  return { title, generated: true };
}
