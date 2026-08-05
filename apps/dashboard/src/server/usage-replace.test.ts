// The predicate that decides what a usage snapshot clears. The case that matters is a
// batch reaching back past its own window: that is what broke sway003-macmini's usage
// sync for five days (P2002 on every run → 500 → nothing written).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { usageReplaceWhere } from './usage-replace';

const SINCE = new Date('2026-07-01T00:00:00.000Z');
const M = 'machine-1';

describe('usageReplaceWhere', () => {
  it('clears just the window when every row sits inside it', () => {
    const where = usageReplaceWhere(M, SINCE, [
      { agentName: 'asst', hourBucket: new Date('2026-07-02T00:00:00.000Z') },
      { agentName: 'ops', hourBucket: SINCE },
    ]);
    assert.equal(where.machineId, M);
    assert.deepEqual(where.OR, [{ hourBucket: { gte: SINCE } }]);
  });

  it('also names the pre-window keys the batch is about to re-insert', () => {
    const old1 = new Date('2026-06-18T00:00:00.000Z');
    const where = usageReplaceWhere(M, SINCE, [
      { agentName: 'asst', hourBucket: old1 },
      { agentName: 'master-skill', hourBucket: old1 },
      { agentName: 'ops', hourBucket: new Date('2026-07-06T00:00:00.000Z') },
    ]);
    assert.deepEqual(where.OR, [
      { hourBucket: { gte: SINCE } },
      { agentName: 'asst', hourBucket: old1 },
      { agentName: 'master-skill', hourBucket: old1 },
    ]);
  });

  it('names each pre-window key once, however often it appears', () => {
    const old1 = new Date('2026-06-18T00:00:00.000Z');
    const where = usageReplaceWhere(M, SINCE, [
      { agentName: 'asst', hourBucket: old1 },
      { agentName: 'asst', hourBucket: old1 },
    ]);
    assert.equal(where.OR.length, 2);
  });

  it('is the window alone for an empty batch', () => {
    assert.deepEqual(usageReplaceWhere(M, SINCE, []).OR, [{ hourBucket: { gte: SINCE } }]);
  });
});
