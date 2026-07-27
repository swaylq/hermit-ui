// Auto-titling a chat session.
//
// The sidebar has always shown the first user message as a session's name
// (ChatSession.preview). That's a decent stand-in and a poor title: the opening
// line of a conversation is usually the setup, not the subject, and two sessions
// that both start "帮我看下这个" are indistinguishable a week later.
//
// So summarize the opening exchange into a short label. Deliberately narrow:
//   · runs ONCE per session, and only while `title` is still null, so a title
//     the user typed is never overwritten;
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

const SYSTEM = [
  'You name chat conversations.',
  'Read the excerpt and reply with ONLY a title: the specific subject or task, as a noun phrase.',
  'Use the same language the conversation is in.',
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
): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;

  const session = await prisma.chatSession.findFirst({
    where: {
      id: sessionId,
      machineId,
      ...(opts.scopedAgent ? { agentName: opts.scopedAgent } : {}),
    },
    select: { id: true, title: true },
  });
  if (!session) return null;
  if (session.title && !opts.force) return session.title;

  const rows = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: SAMPLE_MESSAGES * 4, // most rows are tool traffic with no prose
    select: { role: true, content: true },
  });

  const lines: string[] = [];
  let budget = SAMPLE_CHARS;
  for (const r of rows) {
    const text = extractSearchText(r.content);
    if (!text) continue;
    const who = r.role === 'user' ? 'User' : 'Assistant';
    const slice = text.slice(0, Math.min(600, budget));
    lines.push(`${who}: ${slice}`);
    budget -= slice.length;
    if (lines.length >= SAMPLE_MESSAGES || budget <= 0) break;
  }
  // One line of prose is not a conversation; leave `preview` to do the job.
  if (lines.length === 0) return null;

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
    return null;
  }
  if (!title) return null;

  // Guarded write: only claim the title if it's still unset (unless forcing).
  // Two tabs opening the same session race here, and a manual rename that lands
  // mid-flight must win.
  const res = await prisma.chatSession.updateMany({
    where: { id: sessionId, machineId, ...(opts.force ? {} : { title: null }) },
    data: { title },
  });
  if (res.count === 0) {
    const current = await prisma.chatSession.findUnique({ where: { id: sessionId }, select: { title: true } });
    return current?.title ?? null;
  }
  return title;
}
