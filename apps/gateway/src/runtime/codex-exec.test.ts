import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageFromTurn, readRolloutTokens, findRolloutFile } from './codex-exec';

// The numbers below are a real codex-cli 0.144.1 thread: three trivial turns
// reporting CUMULATIVE input_tokens 28,916 → 43,477 → 58,065, whose rollout
// recorded last_token_usage.input_tokens = 14,588 for the third — exactly
// 58,065 − 43,477. Feeding the cumulative straight through would render a
// context bar that only ever fills up.
test('per-turn context is the delta of the cumulative counters', () => {
  const first = usageFromTurn(
    { input_tokens: 28_916, cached_input_tokens: 25_088, cache_write_input_tokens: 0, output_tokens: 116, reasoning_output_tokens: 0 },
    null,
  );
  assert.deepEqual(first?.lastTurn, { contextTokens: 28_916, outputTokens: 116 });

  const second = usageFromTurn(
    { input_tokens: 43_477, cached_input_tokens: 39_168, cache_write_input_tokens: 0, output_tokens: 125, reasoning_output_tokens: 0 },
    first!.totals,
  );
  assert.deepEqual(second?.lastTurn, { contextTokens: 14_561, outputTokens: 9 });

  const third = usageFromTurn(
    { input_tokens: 58_065, cached_input_tokens: 53_248, cache_write_input_tokens: 0, output_tokens: 134, reasoning_output_tokens: 0 },
    second!.totals,
  );
  // The exact last_token_usage codex wrote for that turn.
  assert.deepEqual(third?.lastTurn, { contextTokens: 14_588, outputTokens: 9 });
  assert.deepEqual(third?.totals, { input: 58_065, output: 134 });
});

// A compaction shrinks the thread, so the next cumulative can be SMALLER than
// the last. A negative delta would render as a negative bar.
test('a shrinking total falls back to the raw figure rather than going negative', () => {
  const out = usageFromTurn(
    { input_tokens: 9_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0 },
    { input: 58_065, output: 134 },
  );
  assert.equal(out?.lastTurn.contextTokens, 9_000);
  assert.equal(out?.lastTurn.outputTokens, 50);
});

test('no usage reported means no figures', () => {
  assert.equal(usageFromTurn(null, null), null);
  assert.equal(usageFromTurn(undefined, { input: 1, output: 1 }), null);
});

// ── the rollout file, which is how a restarted gateway gets its baseline ──────

function fixtureHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const dir = path.join(home, 'sessions', '2026', '08', '11');
  fs.mkdirSync(dir, { recursive: true });
  return home;
}

const tokenLine = (total: [number, number], last: [number, number]) => JSON.stringify({
  timestamp: '2026-08-11T12:22:58.256Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: total[0], output_tokens: total[1], total_tokens: total[0] + total[1] },
      last_token_usage: { input_tokens: last[0], output_tokens: last[1], total_tokens: last[0] + last[1] },
      model_context_window: 258_400,
    },
  },
});

test('the last token_count in a rollout is the one that counts', () => {
  const home = fixtureHome();
  const file = path.join(home, 'sessions', '2026', '08', '11', 'rollout-2026-08-11T20-22-33-thread-abc.jsonl');
  fs.writeFileSync(file, [
    '{"type":"session_meta"}',
    tokenLine([28_916, 116], [28_916, 116]),
    '{"type":"response_item"}',
    tokenLine([58_065, 134], [14_588, 9]),
    '',
  ].join('\n'));

  const out = readRolloutTokens(file);
  assert.deepEqual(out?.total, { input: 58_065, output: 134 });
  assert.deepEqual(out?.lastTurn, { contextTokens: 14_588, outputTokens: 9 });
});

// Only the tail is read, so the first line in the window is usually a fragment.
// It must be skipped, not throw.
test('a truncated leading line does not break the read', () => {
  const home = fixtureHome();
  const file = path.join(home, 'sessions', '2026', '08', '11', 'rollout-x-thread-def.jsonl');
  fs.writeFileSync(file, ['ken_count":{"garbage', tokenLine([10, 2], [4, 1]), ''].join('\n'));
  assert.deepEqual(readRolloutTokens(file)?.lastTurn, { contextTokens: 4, outputTokens: 1 });
});

test('a rollout with no token_count reports nothing', () => {
  const home = fixtureHome();
  const file = path.join(home, 'sessions', '2026', '08', '11', 'rollout-y-thread-ghi.jsonl');
  fs.writeFileSync(file, '{"type":"session_meta"}\n');
  assert.equal(readRolloutTokens(file), null);
});

test('a missing rollout reports nothing rather than throwing', () => {
  assert.equal(readRolloutTokens('/nope/does/not/exist.jsonl'), null);
});

test('a thread is found by id under the dated directories', () => {
  const home = fixtureHome();
  const dir = path.join(home, 'sessions', '2026', '08', '11');
  const file = path.join(dir, 'rollout-2026-08-11T20-22-33-019ff0c6-45a0-7c03-ae54-7d8b99451e89.jsonl');
  fs.writeFileSync(file, '\n');
  assert.equal(findRolloutFile('019ff0c6-45a0-7c03-ae54-7d8b99451e89', home), file);
  assert.equal(findRolloutFile('no-such-thread', home), null);
});

// Newest-day-first, because a resumed thread appends to its ORIGINAL file and
// the common case is a session from today or yesterday.
test('the newest day is searched first', () => {
  const home = fixtureHome();
  const older = path.join(home, 'sessions', '2026', '08', '10');
  const newer = path.join(home, 'sessions', '2026', '08', '12');
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(older, 'rollout-old-shared.jsonl'), '\n');
  fs.writeFileSync(path.join(newer, 'rollout-new-shared.jsonl'), '\n');
  assert.equal(findRolloutFile('shared', home), path.join(newer, 'rollout-new-shared.jsonl'));
});

test('a codex home that does not exist is not an error', () => {
  assert.equal(findRolloutFile('x', '/nope/no/codex/home'), null);
});
