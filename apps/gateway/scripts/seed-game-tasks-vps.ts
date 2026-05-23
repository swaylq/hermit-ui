// One-off: seed game's 4 cron tasks to the VPS dashboard.
// Run from gateway/: `npx tsx scripts/seed-game-tasks-vps.ts`
//
// Prompts are read from the Mac (where they live); we POST each task to the
// dashboard via tRPC. Existing rows get patched via systemUpdate, missing
// rows are created via systemCreate.

import 'dotenv/config';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

function keychainKey(): string {
  const r = spawnSync(
    'security',
    ['find-generic-password', '-a', 'asst', '-s', 'asst-gateway-vps-key', '-w'],
    { encoding: 'utf8' },
  );
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

const DASH = process.env.DASHBOARD_URL ?? 'https://dash.swaylab.ai';
const KEY = process.env.ASST_KEY ?? keychainKey();
if (!KEY) { console.error('missing ASST_KEY'); process.exit(1); }

const GAME_DIR = '/Users/mac/claudeclaw/game/games/model-arena';
const ITER_PROMPT = fs.readFileSync(`${GAME_DIR}/ITER_PROMPT.md`, 'utf8');
const UI_BEAUTY_PROMPT = fs.readFileSync(`${GAME_DIR}/UI_BEAUTY_PROMPT.md`, 'utf8');

type Task = { name: string; intervalSec: number; prompt: string };
const tasks: Task[] = [
  { name: 'arena-iter',         intervalSec: 1800,  prompt: ITER_PROMPT },
  { name: 'arena-ui-beauty',    intervalSec: 3600,  prompt: UI_BEAUTY_PROMPT },
  {
    name: 'arena-matchmake',
    intervalSec: 1800,
    prompt: `本任务: matchmake (model arena 对战分配).

在 ${GAME_DIR} 下执行:

\`\`\`bash
npx tsx scripts/matchmake.ts
\`\`\`

读取它的 stdout/stderr。如果有 ERROR / 异常退出码，简述出错信息。否则报告: 跑了几对对战 / 谁打谁 / 时长。`,
  },
  {
    name: 'arena-sync-models',
    intervalSec: 86400,
    prompt: `本任务: sync-openrouter-models (同步 OpenRouter 最新模型清单).

在 ${GAME_DIR} 下执行:

\`\`\`bash
npx tsx scripts/sync-openrouter-models.ts
\`\`\`

读取 stdout/stderr。汇报: 新增 / 删除 / 价格变动了几个模型，是否有异常。`,
  },
];

async function trpcMutate(procedure: string, input: unknown) {
  // tRPC v11 batched mutation shape.
  const url = `${DASH}/api/trpc/${procedure}?batch=1`;
  const body = { '0': { json: input } };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': KEY },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${procedure} → ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function listTasks() {
  const url = `${DASH}/api/trpc/tasks.systemList?batch=1&input=` + encodeURIComponent(JSON.stringify({ '0': { json: { agentName: 'game' } } }));
  const r = await fetch(url, { headers: { 'x-asst-key': KEY } });
  if (!r.ok) throw new Error('list failed: ' + r.status);
  const data = await r.json();
  return data[0]?.result?.data?.json ?? [];
}

async function main() {
  const existing = await listTasks();
  const byName = new Map<string, any>(existing.map((t: any) => [t.name, t]));

  for (const t of tasks) {
    const cur = byName.get(t.name);
    const common = {
      name: t.name,
      agentName: 'game',
      directory: GAME_DIR,
      prompt: t.prompt,
      intervalSec: t.intervalSec,
      enabled: true,
    };
    if (cur) {
      await trpcMutate('tasks.systemUpdate', { id: cur.id, ...common });
      console.log(`updated  ${t.name}`);
    } else {
      await trpcMutate('tasks.systemCreate', common);
      console.log(`created  ${t.name}`);
    }
  }
  console.log('\nseed done. gateway will fire them on next tick (every 15s).');
}

main().catch((e) => { console.error(e); process.exit(1); });
