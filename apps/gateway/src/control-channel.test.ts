import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardWsUrl } from './control-channel';

test('gateway control authentication never travels in the URL', () => {
  const url = dashboardWsUrl('https://dash.example.test/base?key=sentinel&other=1');
  assert.equal(url, 'wss://dash.example.test/api/gateway/ws');
  assert.doesNotMatch(url, /sentinel|key=/);
});
