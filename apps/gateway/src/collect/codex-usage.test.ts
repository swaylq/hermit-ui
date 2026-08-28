import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectCodexUsage,
  lastTokenCount,
  readCodexLimits,
  recentDayDirs,
  selectCodexLimits,
  type CodexAppServerOptions,
} from './codex-usage';

function tokenLine(total: [number, number]) {
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
    },
  });
}

function home(days: Record<string, string[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  for (const [day, files] of Object.entries(days)) {
    const [year, month, date] = day.split('-');
    const dir = path.join(root, 'sessions', year, month, date);
    fs.mkdirSync(dir, { recursive: true });
    files.forEach((body, index) => {
      fs.writeFileSync(path.join(dir, `rollout-${day}T0${index}-00-00-thread-${index}.jsonl`), body);
    });
  }
  return root;
}

const liveRateLimits = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    planType: 'pro',
    primary: { usedPercent: 19, windowDurationMins: 10_080, resetsAt: 1_788_459_192 },
    secondary: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      limitName: null,
      planType: 'pro',
      primary: { usedPercent: 19, windowDurationMins: 10_080, resetsAt: 1_788_459_192 },
      secondary: null,
    },
    codex_bengalfox: {
      limitId: 'codex_bengalfox',
      limitName: 'GPT-5.3-Codex-Spark',
      planType: 'pro',
      primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1_787_961_900 },
      secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_788_548_700 },
    },
  },
};

function fakeAppServer(result: unknown = liveRateLimits): CodexAppServerOptions {
  const source = `
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    let initialized = false;
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id === 0 && message.method === 'initialize') {
        process.stdout.write(JSON.stringify({ id: 0, result: { userAgent: 'fake' } }) + '\\n');
      } else if (message.method === 'initialized') {
        initialized = true;
      } else if (message.id === 6 && message.method === 'account/rateLimits/read') {
        const reply = initialized
          ? { id: 6, result: ${JSON.stringify(result)} }
          : { id: 6, error: { code: -1, message: 'not initialized' } };
        process.stdout.write(JSON.stringify(reply) + '\\n');
      }
    });
  `;
  return { command: process.execPath, args: ['-e', source], timeoutMs: 2_000, stopGraceMs: 10 };
}

test('the last token_count in a file is the one that counts', () => {
  const text = [tokenLine([100, 10]), '{"type":"response_item"}', tokenLine([300, 30])].join('\n');
  assert.deepEqual(lastTokenCount(text), { input: 300, output: 30 });
});

test('a truncated leading line is skipped, not thrown on', () => {
  const text = ['oken_count":{"garba', tokenLine([50, 5])].join('\n');
  assert.deepEqual(lastTokenCount(text), { input: 50, output: 5 });
});

test('a rollout with no token count returns null', () => {
  assert.equal(lastTokenCount('{"type":"session_meta"}\n'), null);
});

test('day directories come back newest first', () => {
  const root = home({
    '2026-08-11': [tokenLine([1, 1])],
    '2026-07-02': [tokenLine([1, 1])],
    '2026-08-05': [tokenLine([1, 1])],
  });
  assert.deepEqual(recentDayDirs(root).map(([, day]) => day), ['2026-08-11', '2026-08-05', '2026-07-02']);
});

test('the directory walk is capped with the newest days kept', () => {
  const days: Record<string, string[]> = {};
  for (let day = 1; day <= 20; day += 1) days[`2026-08-${String(day).padStart(2, '0')}`] = [tokenLine([1, 1])];
  assert.deepEqual(recentDayDirs(home(days), 3).map(([, day]) => day), ['2026-08-20', '2026-08-19', '2026-08-18']);
});

test('five-hour and weekly values keep their real bucket identities', () => {
  const selected = selectCodexLimits(liveRateLimits)!;
  assert.equal(selected.fiveHour?.usedPercent, 4);
  assert.equal(selected.fiveHour?.windowMinutes, 300);
  assert.equal(selected.fiveHour?.limitId, 'codex_bengalfox');
  assert.equal(selected.weekly?.usedPercent, 19);
  assert.equal(selected.weekly?.windowMinutes, 10_080);
  assert.equal(selected.weekly?.limitId, 'codex');
  assert.equal(selected.planType, 'pro');
});

test('ordinary Codex wins both slots if it reports both windows later', () => {
  const general = {
    ...liveRateLimits.rateLimitsByLimitId.codex,
    primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1_787_961_000 },
    secondary: { usedPercent: 23, windowDurationMins: 10_080, resetsAt: 1_788_459_000 },
  };
  const result = {
    rateLimits: general,
    rateLimitsByLimitId: { ...liveRateLimits.rateLimitsByLimitId, codex: general },
  };
  const selected = selectCodexLimits(result)!;
  assert.equal(selected.fiveHour?.limitId, 'codex');
  assert.equal(selected.fiveHour?.usedPercent, 2);
  assert.equal(selected.weekly?.limitId, 'codex');
  assert.equal(selected.weekly?.usedPercent, 23);
});

test('a legacy single-bucket response still yields its weekly value', () => {
  const selected = selectCodexLimits({ rateLimits: liveRateLimits.rateLimits })!;
  assert.equal(selected.fiveHour, null);
  assert.equal(selected.weekly?.usedPercent, 19);
  assert.equal(selected.weekly?.limitId, 'codex');
});

test('zero usage is a reading and reset epochs are seconds', () => {
  const selected = selectCodexLimits({
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_787_961_900 },
      secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_788_548_700 },
    },
  })!;
  assert.equal(selected.fiveHour?.usedPercent, 0);
  assert.equal(selected.weekly?.usedPercent, 0);
  assert.equal(selected.fiveHour?.resetsAt, new Date(1_787_961_900 * 1000).toISOString());
});

test('malformed or empty app-server results are not readings', () => {
  assert.equal(selectCodexLimits(null), null);
  assert.equal(selectCodexLimits({ rateLimitsByLimitId: {} }), null);
  assert.equal(selectCodexLimits({ rateLimits: { limitId: 'codex', primary: {} } }), null);
  assert.equal(selectCodexLimits({
    rateLimits: { limitId: 'codex', primary: { windowDurationMins: 10_080 } },
  }), null);
});

test('an out-of-range reset does not discard an otherwise valid reading', () => {
  const selected = selectCodexLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 11, windowDurationMins: 10_080, resetsAt: 1e20 },
    },
  });
  assert.equal(selected?.weekly?.usedPercent, 11);
  assert.equal(selected?.weekly?.resetsAt, null);
});

test('the app-server handshake waits for initialize and reads id 6', async () => {
  const selected = await readCodexLimits(fakeAppServer());
  assert.equal(selected?.fiveHour?.limitId, 'codex_bengalfox');
  assert.equal(selected?.weekly?.usedPercent, 19);
});

test('a malformed reset completes without waiting for the watchdog', async () => {
  const result = {
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 11, windowDurationMins: 10_080, resetsAt: 1e20 },
    },
  };
  const started = Date.now();
  const selected = await readCodexLimits(fakeAppServer(result));
  assert.equal(selected?.weekly?.usedPercent, 11);
  assert.equal(selected?.weekly?.resetsAt, null);
  assert.ok(Date.now() - started < 1_000);
});

test('an app-server timeout returns null and kills only its child', async () => {
  const source = `process.stdin.resume(); setInterval(() => {}, 1000);`;
  const started = Date.now();
  const selected = await readCodexLimits({
    command: process.execPath,
    args: ['-e', source],
    timeoutMs: 40,
    stopGraceMs: 10,
  });
  assert.equal(selected, null);
  assert.ok(Date.now() - started < 1_000);
});

test('an app-server error or early exit returns null', async () => {
  const selected = await readCodexLimits({
    command: process.execPath,
    args: ['-e', 'process.exit(2)'],
    timeoutMs: 1_000,
    stopGraceMs: 10,
  });
  assert.equal(selected, null);
});

test('collection combines live limits with per-day token totals', async () => {
  const root = home({
    '2026-08-10': [tokenLine([100, 10]), tokenLine([200, 20])],
    '2026-08-11': [tokenLine([5, 1])],
  });
  const out = await collectCodexUsage(root, fakeAppServer());
  assert.equal(out?.fiveHourPct, 4);
  assert.equal(out?.fiveHourLimitId, 'codex_bengalfox');
  assert.equal(out?.weekPct, 19);
  assert.equal(out?.weekLimitId, 'codex');
  assert.equal(out?.usedPercent, 19);
  assert.equal(out?.windowMinutes, 10_080);
  assert.deepEqual(out?.daily, [
    { day: '2026-08-10', inputTokens: 300, outputTokens: 30, sessions: 2 },
    { day: '2026-08-11', inputTokens: 5, outputTokens: 1, sessions: 1 },
  ]);
});

test('a failed live read returns null instead of clearing the last good row', async () => {
  const out = await collectCodexUsage(home({ '2026-08-11': [tokenLine([5, 1])] }), {
    command: process.execPath,
    args: ['-e', 'process.exit(2)'],
    timeoutMs: 1_000,
    stopGraceMs: 10,
  });
  assert.equal(out, null);
});
