import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatEvent, cronReportEvent } from './events';
import { isUrgentKind } from './suppress';

// ── a cron report gets its own lock-screen slot ─────────────────────────────
//
// Sharing the session's collapse key is exactly how 13 hourly rounds produced
// zero notifications on 2026-08-24 (back when this was the session-scoped loop):
// each round was replaced on the way out by the next thing the agent said.
// `blocked` shares the key on purpose ("is waiting" supersedes "replied"); a
// report is the opposite case — it is the thing you asked the task for, and
// ordinary chatter must not be able to evict it.

const REPORT = { machineId: 'm1', sessionId: 's1', agentName: 'humanize', cronName: '语料补齐' };

test('a cron report does not collapse onto the session chat slot', () => {
  const chat = chatEvent({
    machineId: 'm1', sessionId: 's1', agentName: 'humanize',
    content: [{ type: 'text', text: 'let me check that' }],
  });
  const report = cronReportEvent({ ...REPORT, output: '语料补齐 300/300，测试全绿。' });
  assert.ok(chat);
  assert.notEqual(report.collapseKey, chat!.collapseKey);
  assert.equal(report.collapseKey, 's1:cron');
});

test('a cron report opens the conversation, not /cron', () => {
  // The failure event (cronEvent) points at /cron because that is where the run
  // log is. A successful report points at the chat it was posted into.
  const e = cronReportEvent({ ...REPORT, output: '语料补齐 300/300，测试全绿。' });
  assert.equal(e.kind, 'cron');
  assert.equal(e.title, 'humanize · 语料补齐');
  assert.equal(e.body, '语料补齐 300/300，测试全绿。');
  assert.equal(e.path, '/chat?session=s1');
  assert.equal(e.sessionId, 's1');
});

test('the body is the first non-empty line, not the whole report', () => {
  // Cron authors are told to lead with the outcome, so line one IS the headline.
  const e = cronReportEvent({ ...REPORT, output: '\n\n  收敛了。\n\n细节：改了 4 个文件…' });
  assert.equal(e.body, '收敛了。');
});

test('a long first line is capped so the body stays a preview', () => {
  const e = cronReportEvent({ ...REPORT, output: 'x'.repeat(500) });
  assert.equal(e.body.length, 140);
});

test('a cron report is not urgent — it does not pierce a Focus mode', () => {
  // An hourly progress report is not "an agent is stopped waiting on you".
  // Delivered immediately, yes; allowed to make a sound at 03:00, no.
  assert.equal(isUrgentKind('cron'), false);
  assert.equal(isUrgentKind('blocked'), true);
});
