// Local-only: seed a demo agent + chat session + messages so the chat UI has
// something to render while iterating on layout. Idempotent: wipes the prior
// demo session (by title) and recreates. Run: npx tsx scripts/seed-chat-demo.ts
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';

const prisma = new PrismaClient();
const DEMO_TITLE = 'ChatGPT-style UI demo';

async function main() {
  const wanted = process.argv[2] || 'hermit-ui-dev';
  const machine = (await prisma.machine.findFirst({ where: { name: wanted } })) ?? (await prisma.machine.findFirst());
  if (!machine) throw new Error('no machine found — seed one first: npm run seed');
  console.log('seeding under machine', machine.name);

  await prisma.agent.upsert({
    where: { machineId_name: { machineId: machine.id, name: 'alpha' } },
    create: {
      machineId: machine.id, name: 'alpha',
      directory: '/Users/mac/claudeclaw/asst/hermit-ui/agents/alpha',
      identityText: '# IDENTITY\n\nName: **alpha** — a demo hermit agent.',
      userText: '# USER\n\nName: sway', agentsText: '# AGENTS\n\nWorkspace rules…',
      toolsText: '# TOOLS\n\nLocal notes…', evolutionLessons: '- prefer small diffs',
      skillNames: ['brave-search', 'browser-automation', 'cron', 'restart'],
      memorySummary: '12 files in memory/: 2026-05-27.md, 2026-05-26.md …',
      metadataAt: new Date(),
    },
    update: { metadataAt: new Date() },
  });
  // also seed a second agent so the sidebar nav/list shows >1
  await prisma.agent.upsert({
    where: { machineId_name: { machineId: machine.id, name: 'beta' } },
    create: { machineId: machine.id, name: 'beta', directory: '/x/beta', skillNames: ['restart'], metadataAt: new Date() },
    update: {},
  });

  // wipe prior demo sessions (cascade deletes messages)
  await prisma.chatSession.deleteMany({ where: { machineId: machine.id, title: DEMO_TITLE } });

  const now = Date.now();
  const at = (minAgo: number) => new Date(now - minAgo * 60_000);
  const session = await prisma.chatSession.create({
    data: {
      machineId: machine.id, agentName: 'alpha', title: DEMO_TITLE,
      startedAt: at(20), lastMessageAt: at(1),
      alive: true, state: 'idle', pid: 12345, contextTokens: 14200, outputTokens: 800,
      snapshotAt: new Date(),
    },
  });

  const rows: Array<{ role: string; content: unknown; minAgo: number; externalId?: string }> = [
    { role: 'user', minAgo: 18, content: [{ type: 'text', text: 'hey — what are you working on right now?' }] },
    { role: 'assistant', minAgo: 17, externalId: 'msg_a1', content: [
      { type: 'text', text: "Reshaping the **dashboard UI** to feel like ChatGPT.\n\nIn flight:\n\n- move global nav into a left sidebar\n- composer pill + upload buttons\n- test with seeded data\n\n```ts\nconst greeting = 'hi sway';\nconsole.log(greeting);\n```\n\nWant the short version or the details?" },
    ] },
    { role: 'user', minAgo: 12, content: [{ type: 'text', text: 'details please. also can you read the chat page first?' }] },
    { role: 'assistant', minAgo: 11, externalId: 'msg_a2', content: [
      { type: 'thinking', thinking: 'Let me open the chat page to ground the plan.' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/Users/mac/claudeclaw/asst/hermit-ui/apps/dashboard/src/app/chat/page.tsx' } },
    ] },
    { role: 'tool', minAgo: 11, content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: "1483 lines. ChatPageInner + SessionPane + ComposeBar + MessageRow…" }] },
    ] },
    { role: 'assistant', minAgo: 10, externalId: 'msg_a3', content: [
      { type: 'text', text: "Read it — ~1480 lines. The composer already does paste/drop image upload; I'll add an explicit `+` and image button, wrap it in a rounded pill, and move the session list into the global sidebar so the conversation gets the full width." },
    ] },
    { role: 'user', minAgo: 3, content: [{ type: 'text', text: 'great, ship it' }] },
    { role: 'assistant', minAgo: 1, externalId: 'msg_a4', content: [
      { type: 'text', text: 'Shipped — the global nav is now a left sidebar, the conversation fills the screen, and the composer is a rounded pill with **+** (file) and image upload buttons. Take a look. 🚀' },
    ] },
  ];

  for (const r of rows) {
    await prisma.chatMessage.create({
      data: {
        sessionId: session.id, role: r.role, content: r.content as object,
        externalId: r.externalId ?? null,
        deliveredAt: r.role === 'user' ? at(r.minAgo) : null,
        createdAt: at(r.minAgo),
      },
    });
  }
  console.log(`seeded session ${session.id} with ${rows.length} messages for agent alpha`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
