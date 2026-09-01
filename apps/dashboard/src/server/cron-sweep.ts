// Stale cron runs: close the ones nobody is ever going to close.
//
// A CronRun is opened by the gateway (`phase:'start'`) and closed by the gateway
// (`phase:'finish'`). If the gateway dies between the two, nothing closes it — the
// 2h cap that would have produced a `timeout` lives INSIDE that gateway process and
// dies with it. The row then stays `status:'running'` forever, and every surface
// reads that as healthy rather than broken:
//   * /cron paints running amber ("inconclusive"), the same as a run that started
//     ten seconds ago, with no elapsed-time check anywhere in the render path;
//   * the unread dot, the notification count and the inbox feed all filter
//     `status != 'running'`, so it is invisible to each of them;
//   * `nextFire` was stamped at run START, so the "next" column reads
//     "starting soon…" — actively reassuring, and wrong.
// So the failure mode is not a red row nobody clicked. It is no signal at all.
//
// 2026-09-01, mac-local: finance-agent's daily audit fired at 08:09:43Z; a
// `pm2 restart hermit-ui-gateway` at 08:30:13Z killed it 20m30s in
// (`[claude-sdk] closed session=cron-cms (gateway shutdown)`). Nine hours later the
// row still said running, the day's audit had never been written, and nobody had
// been told. This sweep is what turns that into an ordinary reported failure.
//
// This belongs on the dashboard, not the gateway, for the reason instrumentation.ts
// already gives about its two siblings: a gateway that is down is a CAUSE here, so
// the watcher cannot live on it. A gateway-side hook can only ever cover a clean
// shutdown — worth having as a fast path, never as the backstop.

import { prisma } from './db';
import { finishCronRun } from './cron-finish';
import { STALE_MS, classifyStaleRun } from '@/lib/cron-recovery';

// Bounded per tick for the same reason.
const MAX_PER_TICK = 20;
const SWEEP_INTERVAL_MS = 10 * 60_000;

let timer: NodeJS.Timeout | null = null;

const ABANDONED_OUTPUT =
  '[dashboard] 这一轮没有收尾：网关在它跑到一半时退出了（重启、崩溃或掉电），' +
  '所以从来没有人把结果写回来。这次运行没有产出，任务本身没有执行完。';

async function tick(): Promise<void> {
  const now = Date.now();
  try {
    const orphans = await prisma.cronRun.findMany({
      where: {
        status: 'running',
        finishedAt: null,
        firedAt: { lt: new Date(now - STALE_MS) },
      },
      orderBy: { firedAt: 'asc' },
      take: MAX_PER_TICK,
      select: { id: true, cronId: true, firedAt: true },
    });
    if (orphans.length === 0) return;

    let closed = 0;
    let reported = 0;
    for (const run of orphans) {
      const cron = await prisma.cron.findUnique({ where: { id: run.cronId } });
      if (!cron) continue; // cascade should have taken it; nothing to do
      const supersededBy = await prisma.cronRun.count({
        where: { cronId: run.cronId, firedAt: { gt: run.firedAt } },
      });
      const { quiet } = classifyStaleRun({
        firedAtMs: run.firedAt.getTime(),
        now,
        supersededBy,
      });

      if (quiet) {
        await prisma.cronRun.update({
          where: { id: run.id },
          data: { status: 'error', finishedAt: new Date(now), output: ABANDONED_OUTPUT },
        });
        closed++;
        continue;
      }
      // The live case: close it the way a real finish would, so the status, the
      // report into its chat, the push and the catch-up decision all happen
      // through one code path.
      const { retry } = await finishCronRun({
        machineId: cron.machineId,
        cron,
        runId: run.id,
        status: 'error',
        output: ABANDONED_OUTPUT,
        firedAt: run.firedAt,
        now,
      });
      reported++;
      console.log(
        `[cron-sweep] ${run.cronId.slice(0, 8)} (${cron.agentName}): run abandoned ` +
          `${Math.round((now - run.firedAt.getTime()) / 60_000)}min ago → error` +
          (retry.kind === 'retry' ? `, catch-up #${retry.attempt} at ${retry.at.toISOString()}` : ''),
      );
    }
    if (closed) console.log(`[cron-sweep] closed ${closed} old orphaned run(s) quietly`);
    if (reported) console.log(`[cron-sweep] reported ${reported} abandoned run(s)`);
  } catch (e) {
    console.error('[cron-sweep] tick failed:', e);
  }
}

/** Idempotent; off switch is an env var at the host, matching its two siblings. */
export function startStaleCronRunSweep(): void {
  if (timer) return;
  if (process.env.CRON_SWEEP_DISABLED) {
    console.log('[cron-sweep] disabled by CRON_SWEEP_DISABLED');
    return;
  }
  console.log(
    `[cron-sweep] closing cron runs still 'running' after ${STALE_MS / 60_000}min, every ${SWEEP_INTERVAL_MS / 60_000}min`,
  );
  timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  // First pass 90s after boot: a deploy restart happens while gateways are
  // reconnecting, and their in-flight finish POSTs should land before anything is
  // judged abandoned.
  const first = setTimeout(() => void tick(), 90_000);
  first.unref?.();
}

/** Tests / shutdown. */
export function stopStaleCronRunSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
