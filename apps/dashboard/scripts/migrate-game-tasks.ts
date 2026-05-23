// One-off migration: seed the 4 game LaunchAgent cron tasks as SystemTask rows.
// Run from dashboard/: `npx tsx scripts/migrate-game-tasks.ts`
//
// After this completes, manually run:
//   launchctl bootout gui/$(id -u)/ai.claudeclaw.game.cron-arena-iter
//   …(others)
// + delete the plists + the shell wrappers.

import 'dotenv/config';
import fs from 'node:fs';
import { PrismaClient } from '../src/generated/prisma/client';

const prisma = new PrismaClient();

const MACHINE_NAME = 'mac-local';
const GAME_DIR = '/Users/mac/claudeclaw/game/games/model-arena';

const ITER_PROMPT = fs.readFileSync(GAME_DIR + '/ITER_PROMPT.md', 'utf8');
const UI_BEAUTY_PROMPT = fs.readFileSync(GAME_DIR + '/UI_BEAUTY_PROMPT.md', 'utf8');

const tasks = [
  {
    name: 'arena-iter',
    intervalSec: 1800, // every 30 min — matched the old plist
    prompt: ITER_PROMPT,
  },
  {
    name: 'arena-ui-beauty',
    intervalSec: 3600, // every 60 min
    prompt: UI_BEAUTY_PROMPT,
  },
  {
    name: 'arena-matchmake',
    intervalSec: 1800, // every 30 min
    prompt: `本任务: matchmake (model arena 对战分配).

在 ${GAME_DIR} 下执行:

\`\`\`bash
npx tsx scripts/matchmake.ts
\`\`\`

读取它的 stdout/stderr。如果有 ERROR / 异常退出码，简述出错信息。否则报告: 跑了几对对战 / 谁打谁 / 时长。`,
  },
  {
    name: 'arena-sync-models',
    intervalSec: 86400, // daily
    prompt: `本任务: sync-openrouter-models (同步 OpenRouter 最新模型清单).

在 ${GAME_DIR} 下执行:

\`\`\`bash
npx tsx scripts/sync-openrouter-models.ts
\`\`\`

读取 stdout/stderr。汇报: 新增 / 删除 / 价格变动了几个模型，是否有异常。`,
  },
];

async function main() {
  const machine = await prisma.machine.findUnique({ where: { name: MACHINE_NAME } });
  if (!machine) throw new Error(`Machine "${MACHINE_NAME}" not found. Run npm run seed first.`);

  for (const t of tasks) {
    const existing = await prisma.systemTask.findUnique({
      where: { machineId_name: { machineId: machine.id, name: t.name } },
    });
    if (existing) {
      console.log(`exists, updating: ${t.name}`);
      await prisma.systemTask.update({
        where: { id: existing.id },
        data: {
          prompt: t.prompt,
          intervalSec: t.intervalSec,
          agentName: 'game',
          directory: GAME_DIR,
          enabled: true,
        },
      });
    } else {
      console.log(`creating: ${t.name}`);
      await prisma.systemTask.create({
        data: {
          machineId: machine.id,
          agentName: 'game',
          directory: GAME_DIR,
          name: t.name,
          prompt: t.prompt,
          intervalSec: t.intervalSec,
          enabled: false, // start disabled — sway should review prompts (TG refs) before enabling
        },
      });
    }
  }
  console.log('\nseed done. Tasks created with enabled=false. Review prompts in dashboard then enable.');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
