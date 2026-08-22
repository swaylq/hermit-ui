import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayUpgradeKey } from './gateway-ws-auth';

test('gateway auth prefers the non-logging header', () => {
  assert.equal(gatewayUpgradeKey({ 'x-asst-key': 'header-key' }, 'legacy-key'), 'header-key');
});

test('legacy query auth remains available during a rolling upgrade', () => {
  assert.equal(gatewayUpgradeKey({}, 'legacy-key'), 'legacy-key');
  assert.equal(gatewayUpgradeKey({}, undefined), '');
});
