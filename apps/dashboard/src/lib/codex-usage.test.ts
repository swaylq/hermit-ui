import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexWindowSlots } from './codex-usage';

test('named five-hour and weekly readings fill the fixed slots', () => {
  assert.deepEqual(codexWindowSlots({
    fiveHourPct: 3,
    fiveHourResetsAt: '2026-08-29T05:00:00Z',
    fiveHourLimitId: 'codex_bengalfox',
    fiveHourLimitName: 'GPT-5.3-Codex-Spark',
    weekPct: 19,
    weekResetsAt: '2026-09-04T02:00:00Z',
    weekLimitId: 'codex',
  }), {
    fiveHour: {
      usedPercent: 3,
      resetsAt: '2026-08-29T05:00:00Z',
      limitId: 'codex_bengalfox',
      limitName: 'GPT-5.3-Codex-Spark',
    },
    weekly: {
      usedPercent: 19,
      resetsAt: '2026-09-04T02:00:00Z',
      limitId: 'codex',
      limitName: null,
    },
  });
});

test('a legacy 300-minute reading fills only five-hour', () => {
  assert.deepEqual(codexWindowSlots({ usedPercent: 8, windowMinutes: 300, resetsAt: 'five' }), {
    fiveHour: { usedPercent: 8, resetsAt: 'five', limitId: null, limitName: null },
    weekly: null,
  });
});

test('a legacy 10080-minute reading fills only weekly', () => {
  assert.deepEqual(codexWindowSlots({ usedPercent: 18, windowMinutes: 10_080, resetsAt: 'week' }), {
    fiveHour: null,
    weekly: { usedPercent: 18, resetsAt: 'week', limitId: null, limitName: null },
  });
});

test('zero is retained and named fields outrank legacy data', () => {
  assert.deepEqual(codexWindowSlots({
    usedPercent: 91,
    windowMinutes: 300,
    resetsAt: 'legacy',
    fiveHourPct: 0,
    fiveHourResetsAt: 'current',
    fiveHourLimitId: 'codex',
  }).fiveHour, { usedPercent: 0, resetsAt: 'current', limitId: 'codex', limitName: null });
});

test('an unknown legacy duration is not mislabeled', () => {
  assert.deepEqual(codexWindowSlots({ usedPercent: 12, windowMinutes: 60, resetsAt: 'later' }), {
    fiveHour: null,
    weekly: null,
  });
});
