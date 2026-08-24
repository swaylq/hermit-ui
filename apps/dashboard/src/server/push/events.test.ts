import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatEvent, loopRoundEvent } from './events';
import { isUrgentKind } from './suppress';

// ── a loop round gets its own lock-screen slot ──────────────────────────────
//
// Sharing the session's collapse key is exactly how 13 hourly rounds produced
// zero round notifications on 2026-08-24: each round was replaced on the way out
// by the next thing the agent said. `blocked` shares the key on purpose ("is
// waiting" supersedes "replied"); a round is the opposite case — it is the thing
// you asked the loop for, and ordinary chatter must not be able to evict it.

test('a loop round does not collapse onto the session chat slot', () => {
  const args = { machineId: 'm1', sessionId: 's1', agentName: 'humanize' };
  const chat = chatEvent({ ...args, content: [{ type: 'text', text: 'let me check that' }] });
  const round = loopRoundEvent({ ...args, line: '↻ loop c4 · run 15 — 语料补齐 300/300' });
  assert.ok(chat);
  assert.notEqual(round.collapseKey, chat!.collapseKey);
  assert.equal(round.collapseKey, 's1:loop');
});

test('a loop round carries the round line and opens the session', () => {
  const e = loopRoundEvent({
    machineId: 'm1',
    sessionId: 's1',
    agentName: 'humanize',
    line: '↻ loop c4 · run 15 — 语料补齐 300/300',
  });
  assert.equal(e.kind, 'loop');
  assert.equal(e.title, 'humanize · loop');
  assert.equal(e.body, '↻ loop c4 · run 15 — 语料补齐 300/300');
  assert.equal(e.path, '/chat?session=s1');
  assert.equal(e.sessionId, 's1');
});

test('a long round line is capped so the body stays a preview', () => {
  const e = loopRoundEvent({
    machineId: 'm1',
    sessionId: 's1',
    agentName: 'a',
    line: 'x'.repeat(500),
  });
  assert.equal(e.body.length, 140);
});

test('a loop round is not urgent — it does not pierce a Focus mode', () => {
  // An hourly progress report is not "an agent is stopped waiting on you".
  // Delivered immediately, yes; allowed to make a sound at 03:00, no.
  assert.equal(isUrgentKind('loop'), false);
  assert.equal(isUrgentKind('blocked'), true);
});
