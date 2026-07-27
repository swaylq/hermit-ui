// Auto-titling a chat session.
//
// The sidebar has always shown the first user message as a session's name
// (ChatSession.preview). That's a decent stand-in and a poor title: the opening
// line of a conversation is usually the setup, not the subject, and two sessions
// that both start "帮我看下这个" are indistinguishable a week later.
//
// So summarize the opening exchange into a short label. Deliberately narrow:
//   · a title the USER typed is never touched — chat.setTitle marks the row
//     `titleAuto = false` and that's the end of it;
//   · a MACHINE title is refreshed only when the conversation has genuinely
//     moved on (doubled in length, and by at least REFRESH_MIN_GROWTH
//     messages), and the refresh is given the old title so it EXTENDS rather
//     than replaces — a long session's title tracks what it became;
//   · every other call short-circuits on two cheap indexed queries and spends
//     no tokens at all, so the client can fire this on every open;
//   · reads only the first few messages' prose — the topic is established
//     early, and the whole point is to stay cheap;
//   · failure is silent and leaves `preview` in place. A missing title is a
//     cosmetic loss, never a broken session.

import { prisma } from './db';
import { extractSearchText } from './chat-text';
import { openrouterChat } from './openrouter';

const MODEL = process.env.OPENROUTER_TITLE_MODEL || 'deepseek/deepseek-v4-flash';
// Enough messages to see what the conversation turned out to be about, not so
// many that a long session costs real tokens.
const SAMPLE_MESSAGES = 8;
const SAMPLE_CHARS = 3000;
export const TITLE_MAX = 40;
// When to re-title a session that already has a machine title. Both must hold,
// so a refresh costs at most O(log n) model calls over a session's whole life:
// a 26k-message session re-titles ~9 times, not 26k times.
const REFRESH_FACTOR = 2;
const REFRESH_MIN_GROWTH = 40;

/** Should a machine-written title be re-derived yet? */
export function shouldRefresh(previousCount: number | null, currentCount: number): boolean {
  if (previousCount == null) return true; // titled before we tracked counts
  return currentCount >= previousCount * REFRESH_FACTOR && currentCount >= previousCount + REFRESH_MIN_GROWTH;
}

const SYSTEM = [
  'You name chat conversations.',
  'Read the excerpt and reply with ONLY a title: the specific subject or task, as a noun phrase.',
  'Use the same language the conversation is in.',
  'At most 20 characters for Chinese/Japanese/Korean, at most 6 words otherwise.',
  'No quotes, no trailing punctuation, no prefix like "标题:" or "Title:".',
  'Be concrete. "修复滚动跳变" not "技术讨论"; "Postgres index tuning" not "A question".',
].join(' ');

// Refreshing an existing title is a different job from naming a blank session:
// the point is continuity. A conversation that started on caching and moved to
// scrolling should read as covering both, not silently become "滚动修复" and lose
// its own history.
const REFRESH_SYSTEM = [
  SYSTEM,
  'You are UPDATING an existing title because the conversation has continued.',
  'Keep it if it still fits. Widen or replace it only if the conversation has genuinely moved on.',
  'Obey the same length limit.',
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

/**
 * Generate and store a title for `sessionId`. Returns the title, or null when
 * there was nothing to work with / no API key / the model failed.
 *
 * `force` regenerates even if a title already exists (the manual button).
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

  // A name the user chose is final. Only an explicit `force` (the regenerate
  // button) may override it.
  if (session.title && !session.titleAuto && !opts.force) {
    return { title: session.title, generated: false };
  }

  const count = await prisma.chatMessage.count({ where: { sessionId } });

  // Already titled by us, and the conversation hasn't moved on enough to be
  // worth re-reading. This is the common path — no model call, no tokens.
  if (session.title && session.titleAuto && !opts.force && !shouldRefresh(session.titleMsgCount, count)) {
    return { title: session.title, generated: false };
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { title: session.title, generated: false };

  const rows = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: SAMPLE_MESSAGES * 4, // most rows are tool traffic with no prose
    select: { role: true, content: true },
  });
  // On a REFRESH, the opening messages are exactly what the existing title
  // already covers — read the recent end instead, so the update reflects what
  // the conversation has become.
  const refreshing = !!session.title;
  const recent = refreshing
    ? await prisma.chatMessage.findMany({
        where: { sessionId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: SAMPLE_MESSAGES * 4,
        select: { role: true, content: true },
      })
    : [];

  const excerpt = (source: typeof rows, budget: number): string[] => {
    const lines: string[] = [];
    let left = budget;
    for (const r of source) {
      const text = extractSearchText(r.content);
      if (!text) continue;
      const slice = text.slice(0, Math.min(600, left));
      lines.push(`${r.role === 'user' ? 'User' : 'Assistant'}: ${slice}`);
      left -= slice.length;
      if (lines.length >= SAMPLE_MESSAGES || left <= 0) break;
    }
    return lines;
  };

  const opening = excerpt(rows, refreshing ? SAMPLE_CHARS / 2 : SAMPLE_CHARS);
  const latest = refreshing ? excerpt(recent.reverse(), SAMPLE_CHARS / 2) : [];
  // One line of prose is not a conversation; leave `preview` to do the job.
  if (opening.length === 0 && latest.length === 0) return { title: session.title, generated: false };

  const userContent = refreshing
    ? [
        `Existing title: ${session.title}`,
        '',
        'How it began:',
        opening.join('\n\n'),
        '',
        'Where it is now:',
        latest.join('\n\n'),
      ].join('\n')
    : opening.join('\n\n');

  let title: string;
  try {
    title = cleanTitle(
      await openrouterChat(
        key,
        MODEL,
        [
          { role: 'system', content: refreshing ? REFRESH_SYSTEM : SYSTEM },
          { role: 'user', content: userContent },
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
