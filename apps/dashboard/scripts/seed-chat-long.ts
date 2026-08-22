// Local-only: seed ONE long session — enough rows to cross the windowing
// threshold (400) — so the scroll, anchor and height machinery can be measured
// against something the size of a real conversation instead of a demo.
//
// Deliberately mixed: Chinese and English replies (auto-translate only fires on
// the English ones), one-line acknowledgements next to page-long answers (the
// spread is what makes a single average row height a bad guess), and fenced code
// blocks (heights nothing can predict from the text).
//
// Idempotent: wipes the prior long session by title and recreates.
// Run: DATABASE_URL=… npx tsx scripts/seed-chat-long.ts [machine] [pairs]
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';

const prisma = new PrismaClient();
const TITLE = 'long-session scroll fixture';

const EN = [
  'The root cause is that the virtualization window can only guess the height of rows it has never mounted, and when that guess is replaced by a real measurement the total height above the viewport changes.',
  'That correction is applied inside a layout effect before paint, so the row the reader is looking at does not move. It is guarded by a list signature, so a plan computed for one list never corrects against another.',
  'Browser scroll anchoring is disabled on the scroller with `overflow-anchor: none`, which is what makes "any scrollTop change we did not make came from the user" a valid inference in the first place.',
  'Upward pagination pulls sixty messages at a time, committed in two chunks of thirty, newest chunk first, with a frame between them so a phone has time to lay each one out before the next arrives.',
  'Below four hundred rows the window is not used at all — the same DOM, the same behaviour, and no measuring whatsoever. Most conversations never reach that threshold.',
];
const ZH = [
  '根因是虚拟化窗口对没见过的行只能估高，估值被真实测量替换时视口上方的高度会变。',
  '这个修正在 layout effect 里、绘制之前完成，所以读者正在看的那一行不会移动。',
  '滚动容器上用 `overflow-anchor: none` 关掉了浏览器自带的滚动锚定，整个应用里只有我们自己写 scrollTop。',
  '向上翻页一次拉六十条，分两批各三十条提交，最新的一批先来，中间隔一帧。',
  '四百行以下完全不启用窗口：同样的 DOM、同样的行为，连测量都不做。',
];
const ACK = ['好的。', 'Done.', '嗯，我看看。', '✅ 已部署', 'Shipped.', '收到'];
const CODE = '```ts\nconst delta = padTopNow - plan.padTop;\nif (Math.abs(delta) >= 1) vp.scrollTop += delta;\n```';

/** Deterministic, so two runs of a before/after probe see the same conversation. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

function body(rand: () => number, lang: 'en' | 'zh'): string {
  const pool = lang === 'en' ? EN : ZH;
  const r = rand();
  if (r < 0.22) return ACK[Math.floor(rand() * ACK.length)];
  const paras = 1 + Math.floor(rand() * 5);
  const out: string[] = [];
  for (let i = 0; i < paras; i++) out.push(pool[Math.floor(rand() * pool.length)]);
  if (rand() < 0.18) out.splice(1, 0, CODE);
  return out.join('\n\n');
}

async function main() {
  const wanted = process.argv[2] || 'mac-local';
  const pairs = Number(process.argv[3] || 320);
  const machine = (await prisma.machine.findFirst({ where: { name: wanted } })) ?? (await prisma.machine.findFirst());
  if (!machine) throw new Error('no machine found — seed one first: npm run seed');

  await prisma.agent.upsert({
    where: { machineId_name: { machineId: machine.id, name: 'alpha' } },
    create: { machineId: machine.id, name: 'alpha', directory: '/x/alpha', skillNames: [], metadataAt: new Date() },
    update: {},
  });
  await prisma.chatSession.deleteMany({ where: { machineId: machine.id, title: TITLE } });

  const now = Date.now();
  const at = (i: number) => new Date(now - (pairs * 2 - i) * 60_000);
  const session = await prisma.chatSession.create({
    data: {
      machineId: machine.id, agentName: 'alpha', title: TITLE,
      startedAt: at(0), lastMessageAt: at(pairs * 2 - 1),
      alive: true, state: 'idle', pid: 4242, contextTokens: 90_000, outputTokens: 12_000,
      snapshotAt: new Date(),
    },
  });

  const rand = rng(20260822);
  const data: Array<{
    sessionId: string; role: string; content: object; externalId: string | null;
    deliveredAt: Date | null; createdAt: Date;
  }> = [];
  for (let i = 0; i < pairs; i++) {
    // English on the odd turns, so roughly half the replies are translatable.
    const lang = i % 2 === 1 ? 'en' : 'zh';
    data.push({
      sessionId: session.id, role: 'user',
      content: [{ type: 'text', text: lang === 'en' ? `question ${i}: what changed here?` : `第 ${i} 个问题：这里改了什么？` }],
      externalId: null, deliveredAt: at(i * 2), createdAt: at(i * 2),
    });
    data.push({
      sessionId: session.id, role: 'assistant',
      content: [{ type: 'text', text: body(rand, lang) }],
      externalId: `msg_${i}`, deliveredAt: null, createdAt: at(i * 2 + 1),
    });
  }
  await prisma.chatMessage.createMany({ data: data as never });
  console.log(`seeded ${data.length} messages under ${machine.name} — session ${session.id}`);
}

main().finally(() => prisma.$disconnect());
