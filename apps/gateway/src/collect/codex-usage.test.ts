import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCodexUsage, lastTokenCount, recentDayDirs } from './codex-usage';

// Shaped exactly like the records codex writes: `type` on the envelope, the
// numbers under `payload`.
function tokenLine(total: [number, number], limits?: {
  used?: number; window?: number; resets?: number; plan?: string;
}) {
  return JSON.stringify({
    timestamp: '2026-08-11T12:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total[0], output_tokens: total[1] },
        last_token_usage: { input_tokens: 1, output_tokens: 1 },
        model_context_window: 258_400,
      },
      ...(limits
        ? {
            rate_limits: {
              primary: {
                used_percent: limits.used,
                window_minutes: limits.window,
                resets_at: limits.resets,
              },
              plan_type: limits.plan,
            },
          }
        : {}),
    },
  });
}

function home(days: Record<string, string[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  for (const [day, files] of Object.entries(days)) {
    const [y, m, d] = day.split('-');
    const dir = path.join(root, 'sessions', y, m, d);
    fs.mkdirSync(dir, { recursive: true });
    files.forEach((body, i) => {
      fs.writeFileSync(path.join(dir, `rollout-${day}T0${i}-00-00-thread-${i}.jsonl`), body);
    });
  }
  return root;
}

test('the last token_count in a file is the one that counts', () => {
  const text = [tokenLine([100, 10]), '{"type":"response_item"}', tokenLine([300, 30])].join('\n');
  assert.deepEqual(lastTokenCount(text).total, { input: 300, output: 30 });
});

// The tail is read from an offset, so the first line is usually a fragment.
test('a truncated leading line is skipped, not thrown on', () => {
  const text = ['oken_count":{"garba', tokenLine([50, 5])].join('\n');
  assert.deepEqual(lastTokenCount(text).total, { input: 50, output: 5 });
});

// codex writes epoch SECONDS. Treating them as ms puts the reset in 1970 and
// the countdown renders as long past.
test('resets_at is read as epoch seconds', () => {
  const { limits } = lastTokenCount(tokenLine([1, 1], { used: 4, window: 10080, resets: 1_787_055_761, plan: 'prolite' }));
  assert.equal(limits?.resetsAt, new Date(1_787_055_761 * 1000).toISOString());
  assert.equal(limits?.usedPercent, 4);
  assert.equal(limits?.windowMinutes, 10080);
  assert.equal(limits?.planType, 'prolite');
});

test('a rollout with no rate limits still yields its tokens', () => {
  const { total, limits } = lastTokenCount(tokenLine([7, 2]));
  assert.deepEqual(total, { input: 7, output: 2 });
  assert.equal(limits, null);
});

test('day directories come back newest first', () => {
  const root = home({ '2026-08-11': [tokenLine([1, 1])], '2026-07-02': [tokenLine([1, 1])], '2026-08-05': [tokenLine([1, 1])] });
  assert.deepEqual(recentDayDirs(root).map(([, d]) => d), ['2026-08-11', '2026-08-05', '2026-07-02']);
});

test('the walk is capped, newest kept', () => {
  const days: Record<string, string[]> = {};
  for (let d = 1; d <= 20; d += 1) days[`2026-08-${String(d).padStart(2, '0')}`] = [tokenLine([1, 1])];
  const got = recentDayDirs(home(days), 3).map(([, d]) => d);
  assert.deepEqual(got, ['2026-08-20', '2026-08-19', '2026-08-18']);
});

test('per-day totals sum every session of that day', () => {
  const root = home({
    '2026-08-10': [tokenLine([100, 10]), tokenLine([200, 20])],
    '2026-08-11': [tokenLine([5, 1], { used: 3, window: 10080, resets: 1_787_055_761, plan: 'prolite' })],
  });
  const out = collectCodexUsage(root)!;
  // Oldest first — the order a chart draws in.
  assert.deepEqual(out.daily.map((d) => d.day), ['2026-08-10', '2026-08-11']);
  assert.deepEqual(out.daily[0], { day: '2026-08-10', inputTokens: 300, outputTokens: 30, sessions: 2 });
  assert.equal(out.daily[1].sessions, 1);
});

// The limits describe the ACCOUNT, so the freshest copy wins — and days are
// walked newest first.
test('rate limits come from the newest rollout', () => {
  const out = collectCodexUsage(home({
    '2026-08-01': [tokenLine([1, 1], { used: 99, window: 10080, resets: 1, plan: 'old' })],
    '2026-08-11': [tokenLine([1, 1], { used: 3, window: 10080, resets: 1_787_055_761, plan: 'prolite' })],
  }))!;
  assert.equal(out.usedPercent, 3);
  assert.equal(out.planType, 'prolite');
});

// "codex has never run here" and "codex used nothing" are different facts: the
// first hides the whole Usage section, the second shows 0%.
test('a machine that has never run codex reports null', () => {
  assert.equal(collectCodexUsage(fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'))), null);
  assert.equal(collectCodexUsage('/nope/no/codex/home'), null);
});

test('a day directory with no usable rollouts is left out entirely', () => {
  const out = collectCodexUsage(home({
    '2026-08-10': ['{"type":"session_meta"}\n'],
    '2026-08-11': [tokenLine([9, 3])],
  }))!;
  assert.deepEqual(out.daily.map((d) => d.day), ['2026-08-11']);
});
