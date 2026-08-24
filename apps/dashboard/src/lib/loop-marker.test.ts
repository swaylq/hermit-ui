import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopRoundLine, isLoopRound } from './loop-marker';

const text = (t: string) => [{ type: 'text', text: t }];

// ── what a round looks like ─────────────────────────────────────────────────

test('the skill-mandated marker line is a round', () => {
  assert.equal(
    loopRoundLine(text('↻ loop `c4f57e2c` · run 15 — 语料补齐 300/300')),
    '↻ loop c4f57e2c · run 15 — 语料补齐 300/300',
  );
});

test('a report with a preamble above the marker is still a round', () => {
  // The real shape more often than not: the agent narrates, then reports.
  const body = 'Done — the corpus is complete.\n\n---\n\n↻ loop `abc12345` · run 7 — H1 达成\n\nDetail follows.';
  assert.equal(loopRoundLine(text(body)), '↻ loop abc12345 · run 7 — H1 达成');
});

test('a bare string content is read the same way', () => {
  assert.equal(isLoopRound('↻ loop `x1` · run 2 — ok'), true);
});

// ── what is not a round ─────────────────────────────────────────────────────

test('ordinary chatter is not a round', () => {
  assert.equal(loopRoundLine(text('Another stale waiter for the same work. Nothing new.')), null);
  assert.equal(loopRoundLine(text('')), null);
  assert.equal(loopRoundLine(null), null);
  assert.equal(loopRoundLine([]), null);
});

test('an inline mention of the marker is not a round', () => {
  // The loop skill itself says "The leading ↻ loop marker is what makes loop
  // output recognizable" — an agent quoting that has not run a round.
  assert.equal(loopRoundLine(text('The leading ↻ loop marker on run 3 is what makes it recognizable')), null);
});

test('a run number is required — a marker without one is not a round', () => {
  assert.equal(loopRoundLine(text('↻ loop `c4f57e2c` · starting')), null);
});

// ── the tool_use echo, which is the whole reason this reads text blocks only ──
//
// The same iteration writes its marker into .loop-state.json and into the daily
// memory file. Both are Bash tool_use blocks carrying the marker verbatim, and
// counting them would double every round — chat.loopRuns' SQL guards the same
// way.

test('a tool_use block echoing the marker is not a round', () => {
  const echo = [
    { type: 'tool_use', name: 'Bash', input: { command: "echo '↻ loop `c4f57e2c` · run 15 — x' >> memory.md" } },
  ];
  assert.equal(loopRoundLine(echo), null);
});

test('a real round is still found when a tool_use block sits beside it', () => {
  const mixed = [
    { type: 'thinking', thinking: 'let me report' },
    { type: 'tool_use', name: 'Bash', input: { command: "echo '↻ loop `c4` · run 9 — x'" } },
    { type: 'text', text: '↻ loop `c4` · run 9 — 真的报告' },
  ];
  assert.equal(loopRoundLine(mixed), '↻ loop c4 · run 9 — 真的报告');
});

// ── shape of the returned line ──────────────────────────────────────────────

test('the line is collapsed to one line and capped for a lock screen', () => {
  const long = '↻ loop `c4` · run 1 — ' + 'x'.repeat(400);
  const line = loopRoundLine(long);
  assert.ok(line);
  assert.equal(line!.length, 140);
  assert.ok(!line!.includes('\n'));
});

test('markdown emphasis is stripped so the push body reads as text', () => {
  assert.equal(
    loopRoundLine(text('↻ loop `c4` · run 3 — **H1 达成**，5/5 全过')),
    '↻ loop c4 · run 3 — H1 达成，5/5 全过',
  );
});
