import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  kimiArgs, kimiFallbackPaths, kimiHome, kimiProviderType, kimiSpawnEnv, resolveKimiCommand,
  scanWire, wireFileFor, turnFailed, isGoalPrompt, CONFLICTING_KIMI_VARS,
} from './kimi-code';
import type { ModelCredential } from '../pi-config';

const KIMI: ModelCredential = {
  id: 'kimi-code',
  label: 'Kimi Code',
  provider: 'kimi-coding',
  api: 'anthropic-messages',
  baseUrl: 'https://api.kimi.com/coding',
  models: ['k3', 'k3-256k'],
  defaultModel: 'k3',
  secretKey: 'KIMI_API_KEY',
  modelLimits: {
    k3: { contextWindow: 1_048_576, maxTokens: 131_072 },
    'k3-256k': { contextWindow: 262_144, maxTokens: 131_072 },
  },
};

// ── the argv ────────────────────────────────────────────────────────────────

// `--model` takes an exact key from the [models] table, and the env overlay
// leaves that table empty — so passing one fails with `Model "k3" is not
// configured in config.toml`. The model is chosen by KIMI_MODEL_NAME instead.
test('the model never rides on argv', () => {
  const args = kimiArgs('hello', null);
  assert.equal(args.includes('-m'), false);
  assert.equal(args.includes('--model'), false);
});

// `-p` is rejected alongside --yolo / --auto / --plan; print mode is already
// fully auto-approving, so asking for it again is a startup error.
test('no permission flag is passed — print mode refuses them', () => {
  const args = kimiArgs('hello', null);
  for (const flag of ['--yolo', '-y', '--auto', '--plan']) {
    assert.equal(args.includes(flag), false, `${flag} must not be passed`);
  }
});

test('a known session is resumed, a new one is not', () => {
  assert.deepEqual(kimiArgs('hi', 'session_abc'), ['-r', 'session_abc', '--output-format', 'stream-json', '-p', 'hi']);
  assert.deepEqual(kimiArgs('hi', null), ['--output-format', 'stream-json', '-p', 'hi']);
});

// An oversized prompt is parked in a temp file, and the agent's tools are
// scoped to its workspace — so without this the Read that was told to fetch the
// message would be refused.
test('an extra workspace directory rides alongside a resume', () => {
  assert.deepEqual(
    kimiArgs('hi', 'session_abc', ['/tmp/hermit-kimi-ab12']),
    ['-r', 'session_abc', '--add-dir', '/tmp/hermit-kimi-ab12', '--output-format', 'stream-json', '-p', 'hi'],
  );
});

// ── the endpoint ────────────────────────────────────────────────────────────

// kimi's own `type: "kimi"` speaks OpenAI chat-completions and appends
// /chat/completions to the base URL, so the fleet's stored
// https://api.kimi.com/coding 404s under it while the same URL answers under
// `anthropic`. Measured against 0.38.0.
test('the credential api maps onto kimi provider types, and never onto "kimi"', () => {
  assert.equal(kimiProviderType('anthropic-messages'), 'anthropic');
  assert.equal(kimiProviderType('openai-completions'), 'openai');
  assert.equal(kimiProviderType('openai-responses'), 'openai_responses');
  // Blank is what an older credential row holds; the dashboard's own default.
  assert.equal(kimiProviderType(''), 'anthropic');
  assert.equal(kimiProviderType(null), 'anthropic');
  assert.equal(kimiProviderType(undefined), 'anthropic');
});

test('the spawn env points one child at one credential and one model', () => {
  const env = kimiSpawnEnv(KIMI, 'sk-test', 'k3');
  assert.equal(env.KIMI_MODEL_NAME, 'k3');
  assert.equal(env.KIMI_MODEL_API_KEY, 'sk-test');
  assert.equal(env.KIMI_MODEL_PROVIDER_TYPE, 'anthropic');
  assert.equal(env.KIMI_MODEL_BASE_URL, 'https://api.kimi.com/coding');
  assert.equal(env.KIMI_MODEL_THINKING_EFFORT, 'max');
  assert.equal(env.KIMI_DISABLE_TELEMETRY, '1');
});

// Without this the CLI assumes 262144 for every env-configured model, and a k3
// session would compact at a quarter of its real window.
test('the window comes from the credential, per model', () => {
  assert.equal(kimiSpawnEnv(KIMI, 'k', 'k3').KIMI_MODEL_MAX_CONTEXT_SIZE, '1048576');
  assert.equal(kimiSpawnEnv(KIMI, 'k', 'k3-256k').KIMI_MODEL_MAX_CONTEXT_SIZE, '262144');
});

// maxOutputSize is read on the anthropic protocol only. Setting it elsewhere is
// ignored, which is worse than not setting it: it reads as applied.
test('the output cap is set only where the CLI reads it', () => {
  assert.equal(kimiSpawnEnv(KIMI, 'k', 'k3').KIMI_MODEL_MAX_OUTPUT_SIZE, '131072');
  const openai = kimiSpawnEnv({ ...KIMI, api: 'openai-completions' }, 'k', 'k3');
  assert.equal(openai.KIMI_MODEL_MAX_OUTPUT_SIZE, undefined);
});

test('an unpinned session falls back to the credential default model', () => {
  assert.equal(kimiSpawnEnv(KIMI, 'k', null).KIMI_MODEL_NAME, 'k3');
  assert.equal(kimiSpawnEnv({ ...KIMI, defaultModel: undefined }, 'k', null).KIMI_MODEL_NAME, 'k3');
});

// Empty means "do not spawn": a child launched without these fails at the
// CLI's own auth gate, where the message names __kimi_env__ and helps nobody.
test('nothing to point at yields no env at all', () => {
  assert.deepEqual(kimiSpawnEnv(KIMI, null, 'k3'), {});
  assert.deepEqual(kimiSpawnEnv(null, 'sk-test', 'k3'), {});
  assert.deepEqual(kimiSpawnEnv({ ...KIMI, models: [], defaultModel: undefined }, 'sk-test', null), {});
});

// A blank base URL is legal in Settings → Models — for dsh it means "the
// harness supplies its own catalog". Here it would mean api.anthropic.com,
// i.e. posting a Moonshot key to Anthropic. Refusing is the only safe read.
test('a credential with no endpoint is refused rather than defaulted', () => {
  assert.deepEqual(kimiSpawnEnv({ ...KIMI, baseUrl: '' }, 'sk-test', 'k3'), {});
  assert.deepEqual(kimiSpawnEnv({ ...KIMI, baseUrl: '   ' }, 'sk-test', 'k3'), {});
});

// With no KIMI_MODEL_BASE_URL the CLI resolves the endpoint through the
// provider definition's env names, so a stray ANTHROPIC_BASE_URL in the
// gateway's own environment would silently redirect a Kimi session elsewhere.
test('the vars that could redirect or double-authenticate a child are named', () => {
  for (const v of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'KIMI_API_KEY', 'KIMI_BASE_URL']) {
    assert.ok((CONFLICTING_KIMI_VARS as readonly string[]).includes(v), `${v} must be stripped from the child env`);
  }
});

// ── did the turn fail? ──────────────────────────────────────────────────────

// The trap this replaced: the CLI writes its version line before doing anything
// else, so "we saw output" is true even for a run that dies at its own auth
// gate — and the failure would reach the user as an empty reply.
test('a non-zero exit is a failure even when the turn produced output first', () => {
  assert.equal(turnFailed(1, false, false), true);
  assert.equal(turnFailed(0, false, false), false);
});

// An interrupted turn already reports itself; saying it failed as well would put
// two contradictory notes under one stop button.
test('an interrupted turn is not a failure', () => {
  assert.equal(turnFailed(130, true, false), false);
  assert.equal(turnFailed(1, true, false), false);
});

// Goal mode reports its terminal state through the exit code, and a user can
// type /goal into an ordinary chat.
test('goal mode terminal states are not failures, but only for a goal prompt', () => {
  assert.equal(turnFailed(3, false, true), false);
  assert.equal(turnFailed(6, false, true), false);
  assert.equal(turnFailed(1, false, true), true);
  // The same codes from an ordinary prompt ARE failures.
  assert.equal(turnFailed(3, false, false), true);
  assert.equal(turnFailed(6, false, false), true);
});

test('goal prompts are recognised the way the CLI recognises them', () => {
  assert.equal(isGoalPrompt('/goal ship the thing'), true);
  assert.equal(isGoalPrompt('  /goal'), true);
  assert.equal(isGoalPrompt('/goals are good'), false);
  assert.equal(isGoalPrompt('tell me about /goal'), false);
  assert.equal(isGoalPrompt(''), false);
});

// ── where it looks for the binary and the store ─────────────────────────────

test('the binary override wins, and an absent kimi is null rather than a guess', () => {
  assert.equal(resolveKimiCommand({ HERMIT_KIMI_BIN: '/opt/kimi', PATH: '' }), '/opt/kimi');
  // A machine without kimi must report that, not spawn a path that does not
  // exist and surface as ENOENT with no explanation in the chat.
  assert.equal(resolveKimiCommand({ PATH: '/nonexistent-abcdef' }, []), null);
  assert.equal(resolveKimiCommand({}, []), null);
});

// A gateway started by launchd has neither ~/.local/bin nor the npm prefix on
// its PATH — the single most-repeated failure on this fleet — so the
// well-known locations are searched even when PATH says nothing.
test('the launchd PATH gap is covered by name', () => {
  const paths = kimiFallbackPaths('/Users/someone');
  assert.deepEqual(paths, ['/Users/someone/.local/bin/kimi', '/opt/homebrew/bin/kimi', '/usr/local/bin/kimi']);
});

test('the session store follows KIMI_CODE_HOME, and HERMIT_KIMI_HOME overrides it', () => {
  assert.equal(kimiHome({ KIMI_CODE_HOME: '/tmp/a' }), '/tmp/a');
  assert.equal(kimiHome({ KIMI_CODE_HOME: '/tmp/a', HERMIT_KIMI_HOME: '/tmp/b' }), '/tmp/b');
  assert.equal(kimiHome({}), path.join(os.homedir(), '.kimi-code'));
});

// ── usage, read back out of kimi's own session log ─────────────────────────

function fixture(): { home: string; wire: string; sessionId: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-kimi-test-'));
  const sessionId = 'session_c788d9c9-62e2-4df6-a3fb-0faa46668626';
  const dir = path.join(home, 'sessions', 'wd_x_0123456789ab', sessionId);
  fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'session_index.jsonl'),
    `${JSON.stringify({ sessionId: 'session_other', sessionDir: '/nope', workDir: '/nope' })}\n`
    + `${JSON.stringify({ sessionId, sessionDir: dir, workDir: '/tmp/x' })}\n`,
  );
  return { home, wire: path.join(dir, 'agents', 'main', 'wire.jsonl'), sessionId };
}

// Reproducing the directory name means reproducing a sha256 the CLI computes —
// coupling that breaks silently the day they change the slug rule.
test('the log is found through the index, not by rebuilding the directory name', () => {
  const { home, wire, sessionId } = fixture();
  assert.equal(wireFileFor(home, sessionId), wire);
  assert.equal(wireFileFor(home, 'session_missing'), null);
  assert.equal(wireFileFor('/nonexistent-abcdef', sessionId), null);
});

// Real lines from a captured wire.jsonl. The counters are DISJOINT — billed
// input is the sum of the three — and token_counting.measured is the live
// window occupancy the context bar wants.
const TURN_1 = [
  '{"type":"usage.record","agentId":"main","model":"kimi-code/k3","usage":{"inputOther":4090,"output":34,"inputCacheRead":16896,"inputCacheCreation":0},"usageScope":"turn","time":1}',
  '{"type":"token_counting.measured","agentId":"main","length":3,"tokens":21020,"time":2}',
  '{"type":"turn.ended","agentId":"main","turnId":0,"reason":"completed","durationMs":35200,"time":3}',
  '',
].join('\n');

const TURN_2 = [
  '{"type":"usage.record","agentId":"main","model":"kimi-code/k3","usage":{"inputOther":2303,"output":99,"inputCacheRead":18176,"inputCacheCreation":0},"usageScope":"turn","time":4}',
  '{"type":"token_counting.measured","agentId":"main","length":6,"tokens":20578,"time":5}',
  '',
].join('\n');

test('token counters come out of the session log the CLI writes for itself', () => {
  const { home, wire, sessionId } = fixture();
  fs.writeFileSync(wire, TURN_1);

  const first = scanWire(wireFileFor(home, sessionId)!, 0, null);
  assert.ok(first);
  assert.equal(first.totals.input, 4090 + 16896);
  assert.equal(first.totals.output, 34);
  assert.equal(first.totals.contextTokens, 21020);
  assert.equal(first.totals.lastOutput, 34);
  assert.equal(first.offset, Buffer.byteLength(TURN_1));
});

// A long session's log is megabytes; re-reading it after every turn is what
// this offset exists to avoid.
test('a second turn adds to the totals without re-reading the first', () => {
  const { home, wire, sessionId } = fixture();
  fs.writeFileSync(wire, TURN_1);
  const first = scanWire(wireFileFor(home, sessionId)!, 0, null)!;

  fs.appendFileSync(wire, TURN_2);
  const second = scanWire(wire, first.offset, first.totals)!;

  assert.equal(second.totals.input, 4090 + 16896 + 2303 + 18176);
  assert.equal(second.totals.output, 34 + 99);
  // The LATEST measurement, not a sum — a cumulative one would render as a
  // context bar that only ever fills up.
  assert.equal(second.totals.contextTokens, 20578);
  assert.equal(second.totals.lastOutput, 99);
});

// A session reset truncates the file. Reading on from a stale offset would land
// mid-line and silently under-count from then on.
test('a truncated log is re-read from the top rather than from a stale offset', () => {
  const { home, wire, sessionId } = fixture();
  fs.writeFileSync(wire, TURN_1 + TURN_2);
  const big = scanWire(wireFileFor(home, sessionId)!, 0, null)!;

  fs.writeFileSync(wire, TURN_1);
  const after = scanWire(wire, big.offset, big.totals)!;
  assert.equal(after.totals.input, 4090 + 16896);
  assert.equal(after.totals.output, 34);
});

test('a half-written tail line is skipped, not fatal', () => {
  const { home, wire, sessionId } = fixture();
  fs.writeFileSync(wire, `${TURN_1}{"type":"usage.record","usage":{"inputOth`);
  const scanned = scanWire(wireFileFor(home, sessionId)!, 0, null)!;
  assert.equal(scanned.totals.input, 4090 + 16896);
});

test('a log that does not exist yet is not an error', () => {
  const { home, sessionId } = fixture();
  assert.equal(scanWire(wireFileFor(home, sessionId)!, 0, null), null);
});
