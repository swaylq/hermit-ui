// The predicate behind the unanswered-message alert. Two things are worth locking
// down here, and they pull in opposite directions:
//
//   1. It must FIRE on the 2026-07-31 shape — a human message that is the last word
//      in a live session — because that is the incident this exists for.
//   2. It must STAY SILENT on everything that merely looks similar: a `tool_result`
//      (role 'user' in Anthropic's format), the Brain's takeover messages, an agent
//      thinking for four minutes. A monitor with no off state is not a monitor.
//
// Loosening clause (2) is the failure mode that turns this into a bell that rings
// every day, and it is invisible at runtime — the alerts just start looking normal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHumanRow, isUnanswered, UNANSWERED_MINUTES, type LastMessageRow } from './unanswered';
import { shouldPush, isUrgentKind } from './push/suppress';
import { unansweredEvent } from './push/events';

const NOW = new Date('2026-07-31T14:30:00Z');
const MIN = 60_000;
const T = 30 * MIN;

function row(over: Partial<LastMessageRow> = {}): LastMessageRow {
  return {
    sessionId: 's1',
    machineId: 'm1',
    agentName: 'finance-agent',
    title: '四个 0002 原因排查',
    unansweredMsgId: null,
    state: 'idle',
    alive: true,
    msgId: 'msg1',
    role: 'user',
    authoredBy: null,
    externalId: null,
    createdAt: new Date(NOW.getTime() - 33 * MIN),
    content: [{ type: 'text', text: '查看为什么线上挂了' }],
    ...over,
  };
}

test('the 2026-07-31 shape fires: a human message is the last word, 33 min old', () => {
  assert.equal(isUnanswered(row(), NOW, T), true);
});

test('a live-but-idle session is no defence — that is exactly what the incident looked like', () => {
  assert.equal(isUnanswered(row({ alive: true, state: 'idle' }), NOW, T), true);
  // ...and neither is a session that still reports itself busy (the oversized-paste
  // wedge sits at "starting" forever). Runtime state is never in the predicate.
  assert.equal(isUnanswered(row({ alive: true, state: 'working' }), NOW, T), true);
});

test('an agent taking its time is silent — 4 minutes is the 99th percentile, not a fault', () => {
  assert.equal(isUnanswered(row({ createdAt: new Date(NOW.getTime() - 4 * MIN) }), NOW, T), false);
});

test('it trips exactly at the threshold, not before', () => {
  assert.equal(isUnanswered(row({ createdAt: new Date(NOW.getTime() - T + 1000) }), NOW, T), false);
  assert.equal(isUnanswered(row({ createdAt: new Date(NOW.getTime() - T) }), NOW, T), true);
});

test("a tool_result is not the human, however old — it is role 'user' in Anthropic's format", () => {
  const toolResult = row({ externalId: 'toolu_01ABC', content: [{ type: 'tool_result', content: 'ok' }] });
  assert.equal(isHumanRow(toolResult), false);
  assert.equal(isUnanswered(toolResult, NOW, T), false);
});

test("the Brain's own takeover message is not the human waiting", () => {
  const brain = row({ authoredBy: 'brain' });
  assert.equal(isHumanRow(brain), false);
  assert.equal(isUnanswered(brain, NOW, T), false);
});

test('an agent reply as the last word is silence, not a stall', () => {
  assert.equal(isUnanswered(row({ role: 'assistant', externalId: 'msg_x' }), NOW, T), false);
});

test("a system row ('[session restarted …]') is not someone waiting on an answer", () => {
  assert.equal(isUnanswered(row({ role: 'system', externalId: 'sys_1' }), NOW, T), false);
});

test('the default threshold is the measured one, not a round number someone liked', () => {
  // 30 min is where the 61-day firing curve goes flat (3 firings, all real). Changing
  // it is a decision to re-measure — see docs/unanswered-alert-design.md.
  assert.equal(UNANSWERED_MINUTES, 30);
});

test('a stall is urgent enough to pierce a Focus mode', () => {
  // It can only fire some minutes after the human themself typed something, so it
  // cannot interrupt anyone who was not just at the keyboard. Quiet hours used to
  // be the thing this had to survive; now the phone owns time-of-day and all this
  // asserts is that we mark it urgent rather than informative.
  assert.equal(isUrgentKind('stall'), true);
  assert.equal(isUrgentKind('chat'), false);
});

test('a stall you are staring at is not pushed', () => {
  const decision = shouldPush({
    now: NOW.getTime(),
    lastReadAt: new Date(NOW.getTime() - 10_000),
  });
  assert.deepEqual(decision, { send: false, reason: 'viewing' });
});

test('the push leads with the question, so it is triageable from the lock screen', () => {
  const e = unansweredEvent({
    machineId: 'm1',
    sessionId: 's1',
    agentName: 'finance-agent',
    content: [{ type: 'text', text: '查看为什么线上挂了' }],
    waitedMinutes: 33,
    state: 'idle',
  });
  assert.equal(e.kind, 'stall');
  assert.equal(e.title, 'finance-agent never answered');
  assert.match(e.body, /查看为什么线上挂了/);
  assert.match(e.body, /33 min, no reply/);
  assert.equal(e.path, '/chat?session=s1');
  // One lock-screen slot per session, shared with chat/blocked rather than stacking.
  assert.equal(e.collapseKey, 's1');
});

test('an image-only message still alerts — it has no text, but it is still unanswered', () => {
  const e = unansweredEvent({
    machineId: 'm1',
    sessionId: 's1',
    agentName: 'asst',
    content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
    waitedMinutes: 31,
    state: 'pane gone',
  });
  assert.match(e.body, /31 min, no reply/);
  assert.match(e.body, /pane gone/);
});
