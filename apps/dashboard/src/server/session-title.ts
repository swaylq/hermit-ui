// Naming a chat session after what the USER has been asking it for.
//
// The sidebar used to show the first user message (ChatSession.preview): the
// opening line, which is the setup rather than the subject, and which stops
// describing anything useful once a session runs for days.
//
// The title is built from the user's own messages — all of them. That's the
// thread of intent through a session: what was asked, and what it turned into.
// The agent's replies are deliberately NOT read. They are long, they narrate
// process, and a title drawn from them drifts toward whatever tool the agent
// happened to be running rather than what the session is for.
//
// "The user's messages" means the ones a person typed — `role: 'user'` alone
// also covers tool results and images the agent pulled in mid-task, which are
// role 'user' in Anthropic's format. The marker is `externalId: null`: the
// composer never sets one, every row synced from the transcript carries one.
// This is the same distinction USER_QUEUE_FILTER draws in routers/chat.ts.
//
// Refreshed every REFRESH_AFTER_USER_MESSAGES new user messages, counted in the
// same unit — a session can log hundreds of tool rows without the user saying
// anything, and none of that changes what the session is about.
//
// Labels are always Simplified Chinese, whatever language the session runs in.
//
// A title the USER typed is never touched — chat.setTitle marks the row
// `titleAuto = false` and that ends it. Failure is silent and leaves whatever
// was there; a missing title is cosmetic, never a broken session.

import { prisma } from './db';
import { extractSearchText } from './chat-text';
import { openrouterChat } from './openrouter';

const MODEL = process.env.OPENROUTER_TITLE_MODEL || 'deepseek/deepseek-v4-flash';
export const TITLE_MAX = 40;
// New user messages required before the title is re-derived.
const REFRESH_AFTER_USER_MESSAGES = 5;
// Per-message and total caps on what gets sent. Generous enough that an ordinary
// session is included in full; a very long one keeps its most recent asks, which
// are the ones that describe where it has got to.
const PER_MESSAGE_CHARS = 400;
const TOTAL_CHARS = 4000;

// Human-composed user messages — see the note above about externalId.
const HUMAN_USER = { role: 'user', externalId: null } as const;

const SYSTEM = [
  'You label a chat conversation, given everything the user has asked in it.',
  'Reply with ONLY the label: what this conversation is for, as a noun phrase.',
  'Weight the most recent requests most heavily — the label should say where the conversation has got to.',
  // Always Chinese, whatever the conversation is in. The sidebar is read by one
  // person and mixed-language labels are harder to scan than translated ones.
  'ALWAYS write the label in Simplified Chinese, even if the conversation is entirely in English. Translate as needed.',
  'Proper nouns and code identifiers may stay in their original form (Postgres, IndexedDB, tsconfig).',
  'At most 20 Chinese characters.',
  'No quotes, no trailing punctuation, no prefix like "标题:" or "Title:".',
  'Be concrete. "修复滚动跳变" not "技术讨论"; "Postgres 索引调优" not "一个问题".',
].join(' ');

// Retry prompt for the rare answer that comes back with no Chinese in it at all.
const SYSTEM_ZH_RETRY = SYSTEM + ' Your previous answer was not in Chinese. Reply again, in Simplified Chinese.';

/**
 * Does this label actually contain Chinese? Used to catch the occasional
 * English answer — a label made only of Latin identifiers ("Scoped CSS divider
 * fix") is exactly what we're trying not to ship.
 *
 * CJK Unified Ideographs, plus the Extension A block; deliberately not matching
 * kana, since a Japanese answer is as wrong here as an English one.
 */
export function hasChinese(s: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(s);
}

/** Strip the ways a model still occasionally wraps or prefixes its answer. */
export function cleanTitle(raw: string): string {
  let t = raw.trim().split('\n')[0].trim();
  t = t.replace(/^(标题|title)\s*[:：]\s*/i, '');
  t = t.replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '');
  t = t.replace(/[.。!！?？,，、;；]+$/g, '');
  t = t.trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) : t;
}

/**
 * Has the user said enough new things to be worth re-reading?
 *
 * Counted in USER messages, so a session that runs a thousand tool calls
 * without being asked anything new keeps its title — and five real requests
 * refresh it however long the session already is.
 */
export function shouldRefresh(previousUserCount: number | null, currentUserCount: number): boolean {
  if (previousUserCount == null) return true; // titled before we tracked this
  return currentUserCount - previousUserCount >= REFRESH_AFTER_USER_MESSAGES;
}

/**
 * Assemble the excerpt the model is asked to label: the user's messages, oldest
 * to newest, trimmed to fit. Exported for tests — the trimming rules are the
 * part worth pinning down.
 */
export function buildExcerpt(texts: string[]): string {
  const clipped = texts.map((t) => (t.length > PER_MESSAGE_CHARS ? t.slice(0, PER_MESSAGE_CHARS) + '…' : t));
  // Keep the most recent messages when the whole set won't fit: they say where
  // the conversation has got to, which is what the label is for.
  const kept: string[] = [];
  let budget = TOTAL_CHARS;
  for (let i = clipped.length - 1; i >= 0; i--) {
    if (clipped[i].length > budget) break;
    kept.unshift(clipped[i]);
    budget -= clipped[i].length;
  }
  // Always include at least the latest one, even if it alone exceeds the budget.
  if (kept.length === 0 && clipped.length > 0) kept.push(clipped[clipped.length - 1].slice(0, TOTAL_CHARS));
  return kept.join('\n\n');
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
    select: { id: true, title: true, titleAuto: true, titleUserMsgCount: true },
  });
  if (!session) return { title: null, generated: false };

  // A name the user chose is final. Only an explicit `force` may override it.
  if (session.title && !session.titleAuto && !opts.force) {
    return { title: session.title, generated: false };
  }

  const userCount = await prisma.chatMessage.count({ where: { sessionId, ...HUMAN_USER } });

  // The user hasn't said enough new since we last looked. This is the common
  // path — no model call, no tokens.
  if (session.title && session.titleAuto && !opts.force && !shouldRefresh(session.titleUserMsgCount, userCount)) {
    return { title: session.title, generated: false };
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { title: session.title, generated: false };

  const rows = await prisma.chatMessage.findMany({
    where: { sessionId, ...HUMAN_USER },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { content: true },
  });
  const texts = rows.map((r) => extractSearchText(r.content)).filter((t) => t.length > 0);
  // Nothing the user actually typed (an image-only opener, say) — leave
  // `preview` to do the job.
  if (texts.length === 0) return { title: session.title, generated: false };

  const excerpt = buildExcerpt(texts);
  const ask = (system: string) =>
    openrouterChat(
      key,
      MODEL,
      [
        { role: 'system', content: system },
        { role: 'user', content: excerpt },
      ],
      { temperature: 0.3, reasoningOff: true, timeoutMs: 20_000, title: 'hermit-ui session title' }
    );

  let title: string;
  try {
    title = cleanTitle(await ask(SYSTEM));
    // One retry when the answer came back with no Chinese in it. Rare enough to
    // be worth the call, and the alternative is an English label in a sidebar
    // the instruction says should be Chinese. If the retry fails too we keep
    // what we have — a slightly wrong label beats an unnamed session.
    if (title && !hasChinese(title)) {
      const second = cleanTitle(await ask(SYSTEM_ZH_RETRY));
      if (second && hasChinese(second)) title = second;
    }
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
    data: { title, titleAuto: true, titleUserMsgCount: userCount },
  });
  if (res.count === 0) {
    const current = await prisma.chatSession.findUnique({ where: { id: sessionId }, select: { title: true } });
    return { title: current?.title ?? null, generated: false };
  }
  return { title, generated: true };
}
