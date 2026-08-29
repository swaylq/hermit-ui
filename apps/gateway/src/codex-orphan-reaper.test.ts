import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, selectCodexOrphans } from './codex-orphan-reaper';

// Real argv shape, captured from ps on mac-local 2026-08-29 (trimmed).
const ORPHAN = (pid: number, ppid: number) =>
  `${pid} ${ppid} /Users/mac/claudeclaw/asst/hermit-ui/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex exec --experimental-json --config mcp_servers.hermit.command="node" --config mcp_servers.hermit.args=["/Users/mac/claudeclaw/asst/hermit-ui/apps/gateway/src/mcp-stub.cjs"] --model gpt-5.6-sol resume 01a048b7-c390-77f2-b2e1-01717f57977d`;

test('parsePs reads pid, ppid and the full command', () => {
  const rows = parsePs(`  30845 1 /bin/codex exec x\n63059 59033 /bin/codex exec y\nbad line\n`);
  assert.deepEqual(rows[0], { pid: 30845, ppid: 1, command: '/bin/codex exec x' });
  assert.deepEqual(rows[1], { pid: 63059, ppid: 59033, command: '/bin/codex exec y' });
  assert.equal(rows.length, 2, 'unparseable lines are skipped');
});

test('an orphaned gateway-spawned codex exec is selected', () => {
  const [hit] = selectCodexOrphans(parsePs(ORPHAN(30845, 1)));
  assert.equal(hit.pid, 30845);
});

// The 2026-08-29 incident: this is the row that held thread 01a048b7's writer
// lock for three hours after its gateway died.
test('a codex exec whose gateway is still alive is NOT touched', () => {
  assert.equal(selectCodexOrphans(parsePs(ORPHAN(30845, 59023))).length, 0);
});

test('a human terminal codex is NOT touched even when orphaned', () => {
  const human = `40000 1 /opt/homebrew/bin/codex exec --model gpt-5.6-sol`;
  assert.equal(selectCodexOrphans(parsePs(human)).length, 0);
});

test('the code-mode helper host is not an exec turn', () => {
  const helper = `31971 1 /Users/mac/claudeclaw/asst/hermit-ui/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex-code-mode-host`;
  assert.equal(selectCodexOrphans(parsePs(helper)).length, 0);
});

test('the kill cap bounds the blast radius', () => {
  const out = Array.from({ length: 15 }, (_, i) => ORPHAN(1000 + i, 1)).join('\n');
  assert.equal(selectCodexOrphans(parsePs(out)).length, 10);
});
