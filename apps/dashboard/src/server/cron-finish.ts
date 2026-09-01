// Closing out one cron run: the CronRun row, the Cron's schedule, the report into
// its chat, and the push.
//
// Extracted from app/api/sync/cron-run/route.ts so the stale-run sweep
// (server/cron-sweep.ts) closes an abandoned run through EXACTLY this path rather
// than a second, similar one. That matters more than it looks: on 2026-09-01 a
// finance-agent run was killed mid-flight by a gateway restart, and because the
// finish POST never arrived, none of the four effects below happened — no status,
// no report, no push, no schedule decision. A sweep that reimplemented "close a
// run" would have had to re-derive all four and would have drifted from this one.

import { Prisma } from '@/generated/prisma/client';
import type { Cron } from '@/generated/prisma/client';
import { prisma } from './db';
import { fire as fireChat } from './chat-bus';
import { stripNulDeep } from './sanitize';
import { enqueuePush } from './push';
import { cronEvent, cronReportEvent } from './push/events';
import { decideRetry, type RetryDecision } from '@/lib/cron-recovery';

// Statuses worth waking someone for. `ok` is the happy path and `running` is not
// an outcome; everything else means the task didn't do its job.
export const BAD_STATUS = new Set(['timeout', 'error', 'no_output', 'fail']);

// nextFire = from + interval ± uniform(jitter). The SAME formula the runner uses
// (computeNextFire in apps/gateway/src/cron-runner.ts) — duplicated rather than
// shared because the two live in different apps, and kept in step by hand.
export function computeNextFire(intervalSec: number, jitterSec: number, fromMs: number): Date {
  const jitterMs = jitterSec > 0 ? Math.round((Math.random() * 2 - 1) * jitterSec * 1000) : 0;
  return new Date(fromMs + intervalSec * 1000 + jitterMs);
}

export type { RetryDecision };

export type FinishArgs = {
  machineId: string;
  cron: Cron;
  runId: string | null;
  status: string;
  output?: string;
  durationMs?: number;
  done?: boolean;
  nextIntervalSec?: number;
  /** Which fire this closes. Defaults to the cron's lastFire. */
  firedAt?: Date | null;
  now?: number;
};

/** Close a run: CronRun row → Cron schedule → report into the chat → push. */
export async function finishCronRun(a: FinishArgs): Promise<{ retry: RetryDecision }> {
  const { cron } = a;
  const now = a.now ?? Date.now();

  if (a.runId) {
    await prisma.cronRun.update({
      where: { id: a.runId },
      data: {
        status: a.status,
        output: a.output ?? null,
        durationMs: a.durationMs ?? null,
        finishedAt: new Date(now),
      },
    });
  }

  // `lastStatus` is written on every finish; the rest only when the run signalled
  // something about its own schedule, or when a catch-up is due.
  const cronPatch: Prisma.CronUpdateInput = { lastStatus: a.status };
  const retry = decideRetry({
    status: a.status,
    retryEverySec: cron.retryEverySec,
    retryWindowSec: cron.retryWindowSec,
    retryUntil: cron.retryUntil,
    retryCount: cron.retryCount,
    firedAt: a.firedAt ?? cron.lastFire,
    now,
  });

  if (a.done) {
    // Reached its finish line. It stops firing but keeps the row and its whole run
    // history on /cron. A cron that says it is done is not retried, whatever it
    // reported alongside — that is the run's own explicit last word.
    cronPatch.enabled = false;
    cronPatch.doneAt = new Date(now);
    cronPatch.retryUntil = null;
    cronPatch.retryCount = 0;
  } else {
    if (a.nextIntervalSec) {
      // Re-pace. nextFire MUST be recomputed here: the `start` phase already stamped
      // one derived from the OLD interval, so leaving it alone would let the new
      // cadence take effect one run late — silently, since both values look fine.
      cronPatch.intervalSec = a.nextIntervalSec;
      cronPatch.nextFire = computeNextFire(a.nextIntervalSec, cron.jitterSec, now);
    }
    if (retry.kind === 'retry') {
      // Overrides the ordinary next fire (stamped at run start) AND a re-pace: a
      // catch-up is about the run that just failed, and it is bounded, so it cannot
      // displace the normal cadence for more than the rest of the window.
      cronPatch.nextFire = retry.at;
      cronPatch.retryUntil = retry.until;
      cronPatch.retryCount = retry.attempt;
    } else {
      // Window closed, or this run is not one we retry: back to the ordinary
      // schedule the gateway already stamped, and forget the window.
      cronPatch.retryUntil = null;
      cronPatch.retryCount = 0;
    }
  }
  await prisma.cron.update({ where: { id: cron.id }, data: cronPatch });

  // Deliver the report. A cron runs isolated so it can't grow a conversation's
  // context, but its RESULT belongs where you read things — /cron is a page you have
  // to remember to visit.
  const text = a.output?.trim();
  if (cron.reportSessionId && text) {
    const target = await prisma.chatSession.findFirst({
      where: { id: cron.reportSessionId, machineId: a.machineId, closedAt: null },
      select: { id: true },
    });
    if (target) {
      const label = cron.title?.trim() || cron.agentName;
      const header = a.status === 'ok' ? label : `${label} — ${a.status}`;
      // Say so when another attempt is already scheduled, so the reader is not left
      // deciding whether to go re-run it by hand.
      const footer =
        retry.kind === 'retry'
          ? `\n\n_补跑第 ${retry.attempt} 次已排在 ${retry.at.toISOString()}（窗口截止 ${retry.until.toISOString()}）_`
          : retry.kind === 'giveUp'
            ? '\n\n_当天补跑窗口已过，不再重试，按原计划等下一次_'
            : '';
      await prisma.chatMessage.create({
        data: {
          sessionId: target.id,
          role: 'assistant',
          authoredBy: 'cron',
          externalId: a.runId ? `cron-report-${a.runId}` : null,
          content: stripNulDeep([
            { type: 'text', text: `**${header}**\n\n${text}${footer}` },
          ]) as unknown as Parameters<typeof prisma.chatMessage.create>[0]['data']['content'],
        },
      });
      await prisma.chatSession.update({
        where: { id: target.id },
        data: { lastMessageAt: new Date(now) },
      });
      fireChat(target.id);
      // A report that landed in a conversation gets a notification even on success.
      // Failures fall through to cronEvent below, which points at /cron.
      if (!BAD_STATUS.has(a.status)) {
        enqueuePush(
          cronReportEvent({
            machineId: a.machineId,
            sessionId: target.id,
            agentName: cron.agentName,
            cronName: cron.title?.trim() || cron.agentName,
            output: text,
          }),
        );
      }
    }
  }

  // Failures are pushed wherever they happened — they point at /cron, which is
  // where the run log that explains them lives.
  if (BAD_STATUS.has(a.status)) {
    enqueuePush(
      cronEvent({
        machineId: a.machineId,
        cronId: cron.id,
        runId: a.runId ?? null,
        cronName: cron.title?.trim() || cron.agentName,
        status: a.status,
      }),
    );
  }
  return { retry };
}
