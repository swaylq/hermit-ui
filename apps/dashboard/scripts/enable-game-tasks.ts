import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';

const p = new PrismaClient();
async function main() {
  const m = await p.machine.findUnique({ where: { name: 'mac-local' } });
  if (!m) throw new Error('machine not found');
  const r = await p.systemTask.updateMany({
    where: { machineId: m.id, agentName: 'game' },
    data: { enabled: true },
  });
  console.log(`enabled ${r.count} game tasks`);
  const tasks = await p.systemTask.findMany({
    where: { machineId: m.id, agentName: 'game' },
    orderBy: { name: 'asc' },
  });
  for (const t of tasks) {
    console.log(
      ` - ${t.name} · enabled=${t.enabled} · every ${t.intervalSec}s · lastFire=${t.lastFire ?? 'never'}`,
    );
  }
}
main().finally(() => p.$disconnect());
