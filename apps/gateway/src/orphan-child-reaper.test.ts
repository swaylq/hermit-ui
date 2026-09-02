import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, isCodexOrphan, isClaudeSdkOrphan, planKills } from './orphan-child-reaper';

// Real argv shape, captured from ps on mac-local 2026-08-29 (trimmed).
const ORPHAN = (pid: number, ppid: number) =>
  `${pid} ${ppid} /Users/mac/claudeclaw/asst/hermit-ui/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex exec --experimental-json --config mcp_servers.hermit.command="node" --config mcp_servers.hermit.args=["/Users/mac/claudeclaw/asst/hermit-ui/apps/gateway/src/mcp-stub.cjs"] --model gpt-5.6-sol resume 01a048b7-c390-77f2-b2e1-01717f57977d`;

const row = (pid: number, ppid: number, command: string) => ({ pid, ppid, command });

test('parsePs reads pid, ppid and the full command', () => {
  const rows = parsePs(`  30845 1 /bin/codex exec x\n63059 59033 /bin/codex exec y\nbad line\n`);
  assert.deepEqual(rows[0], { pid: 30845, ppid: 1, command: '/bin/codex exec x' });
  assert.deepEqual(rows[1], { pid: 63059, ppid: 59033, command: '/bin/codex exec y' });
  assert.equal(rows.length, 2, 'unparseable lines are skipped');
});

test('an orphaned gateway-spawned codex exec is selected', () => {
  const [r] = parsePs(ORPHAN(30845, 1));
  assert.equal(isCodexOrphan(r), true);
});

// The 2026-08-29 incident: this is the row that held thread 01a048b7's writer
// lock for three hours after its gateway died.
test('a codex exec whose gateway is still alive is NOT touched', () => {
  const [r] = parsePs(ORPHAN(30845, 59023));
  assert.equal(isCodexOrphan(r), false);
});

test('a human terminal codex is NOT touched even when orphaned', () => {
  assert.equal(isCodexOrphan(row(40000, 1, '/opt/homebrew/bin/codex exec --model gpt-5.6-sol')), false);
});

test('the code-mode helper host is not an exec turn', () => {
  assert.equal(
    isCodexOrphan(row(31971, 1, '/x/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex-code-mode-host')),
    false,
  );
});

// A codex subcommand that is NOT `exec` must not be killed even when it somehow
// carries the hermit marker — the binary-path half of the signature is what
// stands between the reaper and e.g. `codex app-server`.
test('another subcommand with the hermit marker is NOT touched', () => {
  const r = row(42000, 1, '/x/vendor/aarch64-apple-darwin/bin/codex app-server --config mcp_servers.hermit.command="node"');
  assert.equal(isCodexOrphan(r), false);
});

test('the kill cap bounds the blast radius and the overflow is reported', () => {
  const rows = Array.from({ length: 15 }, (_, i) => parsePs(ORPHAN(1000 + i, 1))[0]);
  const { kills, overflow } = planKills(rows, new Set());
  assert.equal(kills.length, 10);
  assert.equal(overflow, 5);
});

test('every planned kill is SIGTERM the first time', () => {
  const rows = [parsePs(ORPHAN(1000, 1))[0]];
  const { kills } = planKills(rows, new Set());
  assert.equal(kills.length, 1);
  assert.deepEqual({ pid: kills[0]!.pid, signal: kills[0]!.signal, backend: kills[0]!.backend },
    { pid: 1000, signal: 'SIGTERM', backend: 'codex' });
});

// A codex exec that ignores SIGTERM must not be re-TERMed forever while the
// thread lock stays held.
test('a pid still in the ps table next tick is escalated to SIGKILL', () => {
  const rows = [parsePs(ORPHAN(1000, 1))[0]];
  const { kills } = planKills(rows, new Set([1000]));
  assert.equal(kills.length, 1);
  assert.equal(kills[0]!.signal, 'SIGKILL');
});

// The `/bin/` path segment is part of the signature too: a codex-shaped binary
// living outside a bin directory (a build dir, a renamed copy) is not something
// this gateway spawned, marker or not.
test('a codex exec outside any bin directory is NOT touched', () => {
  const r = row(43000, 1, '/x/build-out/codex exec --config mcp_servers.hermit.command="node"');
  assert.equal(isCodexOrphan(r), false);
});

// ── claude-sdk ───────────────────────────────────────────────────────────────
// Live argv, captured from ps on mac-local 2026-09-02 (trimmed). The whole
// `--mcp-config` blob is one argv word, which is why `mcp-stub.cjs` shows up on
// the command line at all.
const SDK_CHILD = (pid: number, ppid: number) =>
  `${pid} ${ppid} /Users/mac/.local/bin/claude --output-format stream-json --verbose --input-format stream-json --effort max --mcp-config {"mcpServers":{"hermit":{"command":"node","args":["/Users/mac/claudeclaw/asst/hermit-ui/apps/gateway/src/mcp-stub.cjs"]}}} --permission-mode bypassPermissions --include-partial-messages --session-id=3c3bdd9c-e1ad-4779-b23a-7489846e67d6`;

test('an orphaned claude-sdk child is selected', () => {
  assert.equal(isClaudeSdkOrphan(parsePs(SDK_CHILD(3955, 1))[0]!), true);
});

test('a claude-sdk child whose gateway is alive is NOT touched', () => {
  assert.equal(isClaudeSdkOrphan(parsePs(SDK_CHILD(3955, 52657))[0]!), false);
});

// The pane backend runs the SAME binary and is SUPPOSED to outlive a gateway —
// that is the one thing it does better than the SDK. Reaping it would delete
// the property it exists for.
test('a tmux-pane claude is NOT touched even when orphaned', () => {
  assert.equal(
    isClaudeSdkOrphan(row(720, 1, '/Users/mac/.local/bin/claude --dangerously-skip-permissions')),
    false,
  );
});

test("a human's own headless claude, with no hermit MCP config, is NOT touched", () => {
  assert.equal(
    isClaudeSdkOrphan(row(41000, 1, '/opt/homebrew/bin/claude --output-format stream-json --input-format stream-json -p hi')),
    false,
  );
});

test('claude and codex orphans are both planned, each labelled with its backend', () => {
  const rows = [...parsePs(ORPHAN(1000, 1)), ...parsePs(SDK_CHILD(1001, 1))];
  const { kills } = planKills(rows, new Set());
  assert.deepEqual(kills.map((k) => k.backend), ['codex', 'claude-sdk']);
});
