// Gateway posts cron execution state here. Two phases:
//   start  → create a CronRun(running), stamp the Cron's lastFire + nextFire,
//            return { runId } so the gateway can close it on finish.
//   finish → close the CronRun with status/output/duration, flip lastStatus, and
//            apply whatever the run said about its OWN schedule (see FinishInput).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { fire as fireChat } from '@/server/chat-bus';
import { resolveMachine } from '../route';
import { stripNulDeep } from '@/server/sanitize';
import { enqueuePush } from '@/server/push';
import { cronEvent, cronReportEvent } from '@/server/push/events';

// Statuses worth waking someone for. `ok` is the happy path and `running` is not
// an outcome; everything else means the task didn't do its job. Mirrors the
// settle-loop exit reasons introduced with the cron status semantics fix.
const BAD_STATUS = new Set(['timeout', 'error', 'no_output', 'fail']);

// nextFire = from + interval ± uniform(jitter). The SAME formula the runner uses
// (computeNextFire in apps/gateway/src/cron-runner.ts) — duplicated rather than
// shared because the two live in different apps, and kept in step by hand: a
// re-paced cron gets its next fire computed HERE, every ordinary one gets it there,
// and the two must not drift into different cadences for the same row.
function computeNextFire(intervalSec: number, jitterSec: number, fromMs: number): Date {
  const jitterMs = jitterSec > 0 ? Math.round((Math.random() * 2 - 1) * jitterSec * 1000) : 0;
  return new Date(fromMs + intervalSec * 1000 + jitterMs);
}

const StartInput = z.object({
  phase: z.literal('start'),
  cronId: z.string(),
  firedAt: z.string().datetime(),
  nextFire: z.string().datetime(),
});

const FinishInput = z.object({
  phase: z.literal('finish'),
  cronId: z.string(),
  runId: z.string().nullable().optional(),
  status: z.string(),
  output: z.string().optional(),
  durationMs: z.number().int().optional(),
  // ── What the run said about its own schedule ──
  // Both are markers the run printed on its last line and the gateway stripped out
  // of the report before posting it here (parseRunMarkers in cron-runner.ts). This
  // is what replaced the session-scoped loop: iterate-until-done and pick-your-own
  // -cadence now belong to a durable cron. Absent on an ordinary run, so a cron that
  // never signals anything posts exactly the payload it always did.
  //
  // CRON_DONE — the run reached the goal it was created for and wants no more fires.
  done: z.boolean().optional(),
  // CRON_NEXT <minutes> — re-pace: fire again after this many seconds from now
  // instead of the stored interval. The gateway already refuses out-of-range values;
  // validated again here because this is an HTTP endpoint, not a gateway-only call,
  // and a 1-second interval written straight into the row is a runaway.
  nextIntervalSec: z.number().int().min(60).max(604_800).optional(),
});

const Body = z.discriminatedUnion('phase', [StartInput, FinishInput]);

export async function POST(req: NextRequest) {
  const machine = await resolveMachine(req);
  if (!machine) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: 'bad body', detail: String(e) }, { status: 400 });
  }

  const cron = await prisma.cron.findUnique({ where: { id: body.cronId } });
  if (!cron || cron.machineId !== machine.id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  if (body.phase === 'start') {
    const run = await prisma.cronRun.create({
      data: { cronId: body.cronId, firedAt: new Date(body.firedAt), status: 'running' },
    });
    await prisma.cron.update({
      where: { id: body.cronId },
      data: {
        lastFire: new Date(body.firedAt),
        nextFire: new Date(body.nextFire),
        lastStatus: 'running',
      },
    });
    return NextResponse.json({ runId: run.id });
  }

  // finish
  if (body.runId) {
    await prisma.cronRun.update({
      where: { id: body.runId },
      data: {
        status: body.status,
        output: body.output ?? null,
        durationMs: body.durationMs ?? null,
        finishedAt: new Date(),
      },
    });
  }
  // `lastStatus` is written on every finish; the rest only when the run signalled
  // something about its own schedule.
  const cronPatch: Prisma.CronUpdateInput = { lastStatus: body.status };
  if (body.done) {
    // Reached its finish line. It stops firing but keeps the row and its whole run
    // history on /cron — `doneAt` is what lets the page say 已完成 instead of 已暂停,
    // which is all a bare `enabled: false` can mean. Cleared again on any revive
    // (cron.update / updateFromSession / runNow).
    cronPatch.enabled = false;
    cronPatch.doneAt = new Date();
  } else if (body.nextIntervalSec) {
    // Re-pace. nextFire MUST be recomputed here: the `start` phase above already
    // stamped one derived from the OLD interval, so leaving it alone would let the
    // new cadence take effect one run late — silently, since both values look fine.
    // `done` wins when both markers arrive: a finished cron has no next fire.
    cronPatch.intervalSec = body.nextIntervalSec;
    cronPatch.nextFire = computeNextFire(body.nextIntervalSec, cron.jitterSec, Date.now());
  }
  await prisma.cron.update({ where: { id: body.cronId }, data: cronPatch });

  // Deliver the report. A cron runs isolated so it can't grow a conversation's
  // context, but its RESULT belongs where you read things — /cron is a page you have
  // to remember to visit. Posted as an assistant row stamped authoredBy:'cron', so
  // the timeline can mark it as a scheduled report rather than something the agent
  // said to you just now.
  if (cron.reportSessionId && body.output?.trim()) {
    const target = await prisma.chatSession.findFirst({
      where: { id: cron.reportSessionId, machineId: machine.id, closedAt: null },
      select: { id: true },
    });
    if (target) {
      const label = cron.title?.trim() || cron.agentName;
      const header = body.status === 'ok' ? label : `${label} — ${body.status}`;
      await prisma.chatMessage.create({
        data: {
          sessionId: target.id,
          role: 'assistant',
          authoredBy: 'cron',
          // externalId keyed on the run so a gateway retry of the same finish can't
          // post the report twice.
          externalId: body.runId ? `cron-report-${body.runId}` : null,
          content: stripNulDeep([
            { type: 'text', text: `**${header}**\n\n${body.output.trim()}` },
          ]) as unknown as Parameters<typeof prisma.chatMessage.create>[0]['data']['content'],
        },
      });
      await prisma.chatSession.update({
        where: { id: target.id },
        data: { lastMessageAt: new Date() },
      });
      fireChat(target.id);
      // A report that landed in a conversation gets a notification even on
      // success. This is the half of the retired loop that was NOT redundant:
      // an iterating task is watched round by round, and "it's in the chat, go
      // look" is not watching. Only for a cron that reports into a session —
      // a fleet's worth of quiet daily crons still pushes nothing. Failures fall
      // through to cronEvent below instead, which points at /cron where the run
      // log is.
      if (!BAD_STATUS.has(body.status)) {
        enqueuePush(
          cronReportEvent({
            machineId: machine.id,
            sessionId: target.id,
            agentName: cron.agentName,
            cronName: cron.title?.trim() || cron.agentName,
            output: body.output.trim(),
          }),
        );
      }
    }
  }

  // Failures are pushed wherever they happened — they point at /cron, which is
  // where the run log that explains them lives.
  if (BAD_STATUS.has(body.status)) {
    enqueuePush(
      cronEvent({
        machineId: machine.id,
        cronId: cron.id,
        runId: body.runId ?? null,
        // `title` is the optional short label; fall back to the owning agent so the
        // notification never reads "undefined failed".
        cronName: cron.title?.trim() || cron.agentName,
        status: body.status,
      }),
    );
  }
  return NextResponse.json({ ok: true });
}
