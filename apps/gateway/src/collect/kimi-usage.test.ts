import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKimiUsage, isKimiCodeEndpoint, usagesUrlFor, apiRootFor } from './kimi-usage';

const AT = '2026-08-26T00:00:00.000Z';

// Captured verbatim from api.kimi.com/coding/v1/usages on 2026-08-26. Every
// integer arrives as a STRING, which is the single most likely thing to break
// a rewrite of the parser.
const LIVE = {
  user: {
    userId: 'x', region: 'REGION_CN',
    membership: { level: 'LEVEL_ADVANCED' },
    businessId: '',
  },
  usage: { limit: '100', remaining: '100', resetTime: '2026-09-01T15:44:51.411618Z' },
  limits: [{
    window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { limit: '100', used: '1', remaining: '99', resetTime: '2026-08-25T20:44:51.411618Z' },
  }],
  parallel: { limit: '30' },
  totalQuota: {},
  authentication: { method: 'METHOD_API_KEY', scope: 'FEATURE_CODING' },
  subType: 'TYPE_PURCHASE',
  domain: 'DOMAIN_NEXUS',
};

test('the live body parses into both clocks', () => {
  const s = parseKimiUsage(LIVE, 'kimi-code', AT)!;
  assert.ok(s);
  assert.equal(s.credentialId, 'kimi-code');
  assert.equal(s.planLevel, 'LEVEL_ADVANCED');
  assert.equal(s.parallelLimit, 30);

  // The 7-day subscription quota. `used` is NOT sent on this row — it has to be
  // derived from limit - remaining, or an account halfway through its quota
  // renders as 0% used.
  assert.equal(s.periodLimit, 100);
  assert.equal(s.periodUsed, 0);
  assert.equal(s.periodResetsAt, '2026-09-01T15:44:51.411618Z');

  // The rolling rate window, which is a different fact with a different clock.
  assert.equal(s.windows.length, 1);
  assert.deepEqual(s.windows[0], {
    minutes: 300, used: 1, limit: 100, resetsAt: '2026-08-25T20:44:51.411618Z',
  });
});

test('string integers are read as numbers, not dropped', () => {
  const s = parseKimiUsage(LIVE, 'c', AT)!;
  for (const v of [s.periodLimit, s.periodUsed, s.parallelLimit, s.windows[0].limit, s.windows[0].used]) {
    assert.equal(typeof v, 'number');
  }
});

test('an explicit used wins over the derived one', () => {
  const body = { ...LIVE, usage: { limit: '100', used: '40', remaining: '55' } };
  // 40, not 45: when the vendor states it, believe the vendor. remaining can
  // lag or exclude a pending charge.
  assert.equal(parseKimiUsage(body, 'c', AT)!.periodUsed, 40);
});

test('every window unit converts to minutes', () => {
  const win = (duration: number, timeUnit: string) => parseKimiUsage(
    { usage: LIVE.usage, limits: [{ window: { duration, timeUnit }, detail: { limit: '1', used: '0' } }] },
    'c', AT,
  )!.windows[0].minutes;
  assert.equal(win(300, 'TIME_UNIT_MINUTE'), 300);
  assert.equal(win(5, 'TIME_UNIT_HOUR'), 300);
  assert.equal(win(1, 'TIME_UNIT_DAY'), 1440);
  assert.equal(win(1, 'TIME_UNIT_WEEK'), 10080);
  // An unrecognised unit reports NO period rather than guessing minutes — a
  // percentage with the wrong period stated under it is worse than one with
  // none, because it reads as a fact.
  assert.equal(win(7, 'TIME_UNIT_FORTNIGHT'), null);
});

test('a body with neither quota nor window is not a reading', () => {
  // Most likely an error object that happened to parse. Returning null keeps
  // the row absent instead of writing an all-null one that renders as 0%.
  assert.equal(parseKimiUsage({ error: { message: 'nope' } }, 'c', AT), null);
  assert.equal(parseKimiUsage(null, 'c', AT), null);
  assert.equal(parseKimiUsage('not json', 'c', AT), null);
  assert.equal(parseKimiUsage({ limits: [] }, 'c', AT), null);
});

test('a window with no detail is skipped, not half-written', () => {
  const s = parseKimiUsage({ usage: LIVE.usage, limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } }] }, 'c', AT)!;
  assert.equal(s.windows.length, 0);
  assert.equal(s.periodLimit, 100);
});

test('no wallet reports no balance', () => {
  const s = parseKimiUsage(LIVE, 'c', AT)!;
  assert.equal(s.extraBalanceCents, null);
  assert.equal(s.extraCurrency, null);
});

test('a BOOSTER wallet converts out of fixed point', () => {
  const s = parseKimiUsage({
    ...LIVE,
    boosterWallet: {
      balance: { type: 'BOOSTER', amount: '500000000', amountLeft: '250000000' },
      monthlyChargeLimit: { priceInCents: 2000, currency: 'CNY' },
    },
  }, 'c', AT)!;
  // 1e6 wire units to the cent — 250,000,000 is $2.50.
  assert.equal(s.extraBalanceCents, 250);
  assert.equal(s.extraCurrency, 'CNY');
});

test('a wallet that is not a BOOSTER balance reports nothing', () => {
  const s = parseKimiUsage({
    ...LIVE,
    boosterWallet: { balance: { type: 'SOMETHING_ELSE', amountLeft: '250000000' } },
  }, 'c', AT)!;
  assert.equal(s.extraBalanceCents, null);
});

test('only the managed Kimi hosts are matched', () => {
  assert.equal(isKimiCodeEndpoint('https://api.kimi.com/coding'), true);
  assert.equal(isKimiCodeEndpoint('https://api.kimi.ai/coding/v1'), true);
  // A proxy or a mirror is NOT matched: its response shape is nobody's promise,
  // and a wrong quota reading is worse than none.
  assert.equal(isKimiCodeEndpoint('https://kimi.my-proxy.dev/coding'), false);
  assert.equal(isKimiCodeEndpoint('https://api.moonshot.cn/anthropic'), false);
  assert.equal(isKimiCodeEndpoint('https://litellm.hyqubit.com'), false);
  assert.equal(isKimiCodeEndpoint(''), false);
  assert.equal(isKimiCodeEndpoint(null), false);
  assert.equal(isKimiCodeEndpoint('not a url'), false);
});

test('the usages URL is built for either spelling of the base', () => {
  // Claude Code wants the base WITHOUT /v1; the Kimi CLI's own constant has it.
  assert.equal(usagesUrlFor('https://api.kimi.com/coding'), 'https://api.kimi.com/coding/v1/usages');
  assert.equal(usagesUrlFor('https://api.kimi.com/coding/'), 'https://api.kimi.com/coding/v1/usages');
  assert.equal(usagesUrlFor('https://api.kimi.com/coding/v1'), 'https://api.kimi.com/coding/v1/usages');
  assert.equal(apiRootFor('https://api.kimi.com/coding//'), 'https://api.kimi.com/coding/v1');
});
