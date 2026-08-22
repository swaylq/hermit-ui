import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpConfigArg, buildMcpServers } from './mcp-config';

test('Claude MCP argv contains a variable reference, never the inherited key value', () => {
  const servers = buildMcpServers('session-1');
  assert.equal(servers.hermit.env.HERMIT_KEY, '${HERMIT_KEY}');
  const arg = buildMcpConfigArg('session-1');
  assert.match(arg, /\$\{HERMIT_KEY\}/);
  assert.doesNotMatch(arg, /HERMIT_KEY":"(?!\$\{HERMIT_KEY\})[^"}]+/);
});
