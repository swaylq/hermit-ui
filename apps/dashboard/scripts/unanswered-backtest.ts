#!/usr/bin/env node
// Replay the whole message history through the LIVE unanswered predicate.
//
// This is where the threshold comes from and where it stays honest. It answers the
// two questions that decide whether an alert is worth having:
//
//   - would it have caught the thing it exists for?   (2026-07-31, 188 minutes)
//   - how often does it go off when nothing is wrong? (the off state)
//
// The decision is NOT reimplemented here: the SQL reconstructs, for every human
// message, the window during which it was the last word in its session, and then
// `isUnanswered()` — the same function the sweep calls — is evaluated at the instant
// that window closed. If this file and the runtime ever disagree, this stops working,
// which is the point.
//
// Usage (from apps/dashboard, needs DATABASE_URL):
//   ../../node_modules/.bin/tsx scripts/unanswered-backtest.ts [thresholdMinutes...]

import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { isUnanswered, UNANSWERED_MINUTES, type LastMessageRow } from '../src/server/unanswered';

const prisma = new PrismaClient();

/** The window a human message spent as the last word in its conversation. */
interface Window {
  sessionId: string;
  agentName: string;
  machineName: string;
  title: string | null;
  msgId: string;
  role: string;
  authoredBy: string | null;
  externalId: string | null;
  askedAt: Date;
  /** When the next non-human row landed. NULL = still the last word. */
  answeredAt: Date | null;
  text: string | null;
}

const SHANGHAI = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
  timeStyle: 'short',
});

async function main() {
  const argThresholds = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const thresholds = argThresholds.length > 0 ? argThresholds : [5, 10, 15, 20, 25, 30, 45, 60];
  const now = new Date();

  // Every message, partitioned by session in time order, so LEAD() can say what came
  // next. A window is a human row whose successor is NOT another human row — i.e. the
  // exact row the sweep would find as "newest message, and it's theirs".
  const windows = await prisma.$queryRaw<Window[]>`
    WITH m AS (
      SELECT c.id, c."sessionId", c."createdAt", c.role, c."authoredBy", c."externalId", c.content,
             (c.role = 'user' AND c."authoredBy" IS NULL AND c."externalId" IS NULL) AS is_human,
             s."agentName", s.title, mac.name AS machine_name
      FROM "ChatMessage" c
      JOIN "ChatSession" s ON s.id = c."sessionId"
      JOIN "Machine" mac ON mac.id = s."machineId"
      WHERE s.origin IS NULL
    ), w AS (
      SELECT *,
             LEAD("createdAt") OVER (PARTITION BY "sessionId" ORDER BY "createdAt", id) AS next_at,
             LEAD(is_human)    OVER (PARTITION BY "sessionId" ORDER BY "createdAt", id) AS next_human
      FROM m
    )
    SELECT "sessionId", "agentName", machine_name AS "machineName", title,
           id AS "msgId", role, "authoredBy", "externalId",
           "createdAt" AS "askedAt", next_at AS "answeredAt",
           (SELECT string_agg(b->>'text', ' ') FROM jsonb_array_elements(content::jsonb) b
             WHERE b->>'type' = 'text') AS text
    FROM w
    WHERE is_human AND (next_human IS DISTINCT FROM TRUE)
    ORDER BY "createdAt"
  `;

  if (windows.length === 0) {
    console.error('no windows found — is this pointing at a populated database?');
    process.exit(1);
  }

  const span = await prisma.$queryRaw<Array<{ oldest: Date; newest: Date }>>`
    SELECT min("createdAt") AS oldest, max("createdAt") AS newest FROM "ChatMessage"
  `;
  const days = (span[0].newest.getTime() - span[0].oldest.getTime()) / 86_400_000;

  console.log(
    `${windows.length} windows over ${days.toFixed(1)} days ` +
      `(${SHANGHAI.format(span[0].oldest)} → ${SHANGHAI.format(span[0].newest)}, Shanghai)\n`,
  );

  // How long each answered window actually lasted — the shape the threshold has to sit
  // to the right of.
  const answered = windows
    .filter((w) => w.answeredAt)
    .map((w) => (w.answeredAt!.getTime() - w.askedAt.getTime()) / 1000)
    .sort((a, b) => a - b);
  const pct = (p: number) => answered[Math.min(answered.length - 1, Math.floor(answered.length * p))];
  console.log('reply latency (human spoke last → next non-human row):');
  console.log(
    `  n=${answered.length}  p50=${pct(0.5).toFixed(0)}s  p90=${pct(0.9).toFixed(0)}s  ` +
      `p95=${pct(0.95).toFixed(0)}s  p99=${pct(0.99).toFixed(0)}s  ` +
      `p99.9=${(pct(0.999) / 60).toFixed(1)}min  max=${(answered[answered.length - 1] / 60).toFixed(1)}min\n`,
  );

  // Evaluate the REAL predicate at the moment each window closed.
  const firedAt = (w: Window, thresholdMs: number): boolean => {
    const closed = w.answeredAt ?? now;
    const row: LastMessageRow = {
      sessionId: w.sessionId,
      machineId: '',
      agentName: w.agentName,
      title: w.title,
      unansweredMsgId: null,
      state: null,
      alive: true,
      msgId: w.msgId,
      role: w.role,
      authoredBy: w.authoredBy,
      externalId: w.externalId,
      createdAt: w.askedAt,
      content: null,
    };
    return isUnanswered(row, closed, thresholdMs);
  };

  console.log('firings by threshold:');
  for (const t of thresholds) {
    const hits = windows.filter((w) => firedAt(w, t * 60_000));
    const per = hits.length > 0 ? (days / hits.length).toFixed(1) : '—';
    const mark = t === UNANSWERED_MINUTES ? ' ←' : '';
    console.log(`  ${String(t).padStart(3)} min  ${String(hits.length).padStart(4)} firings   one every ${per} days${mark}`);
  }

  const live = windows.filter((w) => firedAt(w, UNANSWERED_MINUTES * 60_000));
  console.log(`\nevery firing at the live threshold (${UNANSWERED_MINUTES} min):`);
  for (const w of live) {
    const waited = ((w.answeredAt ?? now).getTime() - w.askedAt.getTime()) / 60_000;
    console.log(
      `  ${SHANGHAI.format(w.askedAt)}  ${w.machineName}/${w.agentName}  ` +
        `${waited.toFixed(0)}min${w.answeredAt ? '' : ' (STILL UNANSWERED)'}  ` +
        `“${(w.text ?? '(no text)').replace(/\s+/g, ' ').slice(0, 50)}”`,
    );
  }

  // The regression case. If this ever stops appearing, the alert has stopped doing the
  // one job it was built for.
  const incident = live.find((w) => w.agentName === 'finance-agent' && w.askedAt < new Date('2026-08-01T00:00:00Z'));
  console.log(
    `\n2026-07-31 incident: ${incident ? `CAUGHT — would have alerted at ${SHANGHAI.format(new Date(incident.askedAt.getTime() + UNANSWERED_MINUTES * 60_000))} Shanghai, ${(((incident.answeredAt ?? now).getTime() - incident.askedAt.getTime()) / 60_000 - UNANSWERED_MINUTES).toFixed(0)} min before anything else noticed` : 'NOT CAUGHT — regression'}`,
  );
  process.exit(incident ? 0 : 1);
}

main().finally(() => prisma.$disconnect());
