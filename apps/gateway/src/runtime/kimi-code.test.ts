import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  kimiArgs, kimiFallbackPaths, kimiHome, kimiProviderType, kimiSpawnEnv, resolveKimiCommand,
  scanWire, wireFileFor, wireQuietMs, discoverTurnSession, turnFailed, turnFailureMessage, isGoalPrompt,
  KimiCodeRuntime, CONFLICTING_KIMI_VARS, GATEWAY_ONLY_VARS,
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
  assert.equal(turnFailed(1, null, false, false), true);
  assert.equal(turnFailed(0, null, false, false), false);
});

// The shape Node reports for a signal death is `(null, 'SIGKILL')`, so a check
// that reads only `code` calls every signal death a success. That is not
// hypothetical: the silence watchdog ends a wedged turn exactly this way, and
// the session would flip from working to idle with no note at all.
test('a signal death is a failure, not a clean exit', () => {
  assert.equal(turnFailed(null, 'SIGKILL', false, false), true);
  assert.equal(turnFailed(null, 'SIGSEGV', false, false), true);
  // …unless the stop button caused it, which reports itself.
  assert.equal(turnFailed(null, 'SIGINT', true, false), false);
  // A clean exit still has no signal.
  assert.equal(turnFailed(0, null, false, false), false);
});

// An interrupted turn already reports itself; saying it failed as well would put
// two contradictory notes under one stop button.
test('an interrupted turn is not a failure', () => {
  assert.equal(turnFailed(130, null, true, false), false);
  assert.equal(turnFailed(1, null, true, false), false);
});

// Goal mode reports its terminal state through the exit code, and a user can
// type /goal into an ordinary chat.
test('goal mode terminal states are not failures, but only for a goal prompt', () => {
  assert.equal(turnFailed(3, null, false, true), false);
  assert.equal(turnFailed(6, null, false, true), false);
  assert.equal(turnFailed(1, null, false, true), true);
  // The same codes from an ordinary prompt ARE failures.
  assert.equal(turnFailed(3, null, false, false), true);
  assert.equal(turnFailed(6, null, false, false), true);
  // A goal prompt killed by a signal is still a failure — the exemption is for
  // the codes goal mode chooses, not for however the process died.
  assert.equal(turnFailed(null, 'SIGKILL', false, true), true);
});

test('goal prompts are recognised the way the CLI recognises them', () => {
  assert.equal(isGoalPrompt('/goal ship the thing'), true);
  assert.equal(isGoalPrompt('  /goal'), true);
  assert.equal(isGoalPrompt('/goals are good'), false);
  assert.equal(isGoalPrompt('tell me about /goal'), false);
  assert.equal(isGoalPrompt(''), false);
});

// The gateway's environment is the child's by default, and this backend has no
// hermit tool surface — so without the scrub, `echo $ASST_KEY` inside the
// agent's own Bash tool prints the machine's dashboard credential.
test('the gateway own dashboard key is kept out of the agent shell', () => {
  assert.ok((GATEWAY_ONLY_VARS as readonly string[]).includes('ASST_KEY'));
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

// ── the watchdog's second opinion ──────────────────────────────────────────

// An AgentSwarm turn is mute on stdout while its subagents write to their own
// agents/agent-N/wire.jsonl. Liveness is the NEWEST write anywhere in the
// tree — on 2026-08-28 a swarm was killed as "wedged" while a subagent's log
// was ten seconds old.
test('a subagent writing its own log counts as the session being alive', () => {
  const { home, wire, sessionId } = fixture();
  const now = Date.now();
  fs.writeFileSync(wire, '{}\n');
  fs.utimesSync(wire, new Date(now - 20 * 60 * 1000), new Date(now - 20 * 60 * 1000));

  // Main log 20min stale and nothing else: quiet for 20min.
  assert.equal(wireQuietMs(home, sessionId, now), 20 * 60 * 1000);

  // A swarm subagent wrote 10s ago: the session is 10s quiet, not 20min.
  const sub = path.join(path.dirname(path.dirname(wire)), 'agent-4');
  fs.mkdirSync(sub, { recursive: true });
  const subWire = path.join(sub, 'wire.jsonl');
  fs.writeFileSync(subWire, '{}\n');
  fs.utimesSync(subWire, new Date(now - 10_000), new Date(now - 10_000));
  assert.equal(wireQuietMs(home, sessionId, now), 10_000);

  // A subagent dir with no wire.jsonl yet doesn't spoil the answer.
  fs.mkdirSync(path.join(path.dirname(path.dirname(wire)), 'agent-5'), { recursive: true });
  assert.equal(wireQuietMs(home, sessionId, now), 10_000);

  // Clock skew (mtime ahead of now) clamps to 0, never negative.
  fs.utimesSync(subWire, new Date(now + 60_000), new Date(now + 60_000));
  assert.equal(wireQuietMs(home, sessionId, now), 0);
});

// null means "no evidence either way" — the watchdog falls back to its stdout
// verdict and kills, which is the old behavior for a spawn that truly wedged
// before ever printing (no id learned) or before kimi indexed the session.
test('no id, no index entry, or no logs at all yields null, not a reprieve', () => {
  const { home, sessionId } = fixture();
  assert.equal(wireQuietMs(home, null), null);
  assert.equal(wireQuietMs(home, 'session_missing'), null);
  assert.equal(wireQuietMs('/nonexistent-abcdef', sessionId), null);
  // Indexed, agents/main exists, but no wire.jsonl was ever written.
  assert.equal(wireQuietMs(home, sessionId), null);
});

// ── finding the session a live turn is writing to ──────────────────────────
//
// The resume hint rides the turn's LAST stdout line, so a first turn has no id
// while it runs — and a turn killed mid-run never gets one. 2026-08-29, session
// cmte4wr4: a first turn's swarm wrote to agents/agent-0/wire.jsonl until 6m35s
// before the watchdog fired, but with no id the reprieve check had nothing to
// ask and killed a working turn ("no session log on disk to check against").

const DISCOVER_WORKDIR = '/tmp/game';

function discoveryFixture(): {
  home: string; spawnedAt: number;
  add: (name: string, createdAt: number, prompt: string | null, workDir?: string) => string;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-kimi-discover-'));
  const spawnedAt = Date.now();
  const index: string[] = [];
  const add = (name: string, createdAt: number, prompt: string | null, workDir = DISCOVER_WORKDIR): string => {
    const sessionId = `session_${name}`;
    const dir = path.join(home, 'sessions', 'wd_game_0123456789ab', sessionId);
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    const rows = [JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: createdAt })];
    if (prompt !== null) {
      rows.push(JSON.stringify({
        type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: prompt }], time: createdAt + 30,
      }));
    }
    fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), `${rows.join('\n')}\n`);
    index.push(JSON.stringify({ sessionId, sessionDir: dir, workDir }));
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), `${index.join('\n')}\n`);
    return sessionId;
  };
  return { home, spawnedAt, add };
}

test("discovery finds a first turn's session by the prompt in its log", () => {
  const { home, spawnedAt, add } = discoveryFixture();
  const old = add('old', spawnedAt - 3_600_000, 'unrelated earlier work');
  const fresh = add('fresh', spawnedAt + 400, '把这件事做到完美');
  assert.equal(discoverTurnSession(home, DISCOVER_WORKDIR, spawnedAt, '把这件事做到完美'), fresh);
  assert.notEqual(fresh, old);
});

// The prompt record can be missing from the head slice (a huge inlined system
// prompt plus tools snapshot pushes it past the read cap). With exactly one
// fresh dir the creation time alone is still an unambiguous answer.
test('a sole fresh dir is found even without its prompt in the head slice', () => {
  const { home, spawnedAt, add } = discoveryFixture();
  add('stale', spawnedAt - 3_600_000, null);
  const fresh = add('fresh', spawnedAt + 400, null);
  assert.equal(discoverTurnSession(home, DISCOVER_WORKDIR, spawnedAt, 'anything'), fresh);
});

// But two fresh dirs and no fingerprint is a guess, and a wrong stamp resumes
// somebody else's conversation — worse than the kill this exists to prevent.
test('two fresh dirs with no prompt fingerprint is ambiguous: null', () => {
  const { home, spawnedAt, add } = discoveryFixture();
  add('one', spawnedAt + 400, null);
  add('two', spawnedAt + 900, null);
  assert.equal(discoverTurnSession(home, DISCOVER_WORKDIR, spawnedAt, 'anything'), null);
});

// The strong fingerprint must beat recency: a dir created a beat later that
// does NOT hold this turn's prompt is someone else's session.
test('the prompt fingerprint outranks a newer dir without it', () => {
  const { home, spawnedAt, add } = discoveryFixture();
  const ours = add('ours', spawnedAt + 400, 'write the game');
  add('theirs', spawnedAt + 900, 'something else entirely');
  assert.equal(discoverTurnSession(home, DISCOVER_WORKDIR, spawnedAt, 'write the game'), ours);
});

// A RE-SENT identical message must not resurrect the previous session's dir:
// the prompt matches, but that dir was not created by the child we spawned.
test('an old session with the same prompt is not this turn', () => {
  const { home, spawnedAt, add } = discoveryFixture();
  add('yesterday', spawnedAt - 86_400_000, 'do the thing');
  assert.equal(discoverTurnSession(home, DISCOVER_WORKDIR, spawnedAt, 'do the thing'), null);
});

// The genuinely wedged RESUMED session: its dir is old, nothing was created by
// this child, and discovery must find nothing — the watchdog kills as before.
test('a wedged resumed session still finds nothing', () => {
  const { home, spawnedAt, add } = discoveryFixture();
  add('wedged', spawnedAt - 3_600_000, 'the resumed prompt');
  assert.equal(discoverTurnSession(home, DISCOVER_WORKDIR, spawnedAt, 'the resumed prompt'), null);
});

test("another workDir's sessions are invisible, trailing slash aside", () => {
  const { home, spawnedAt, add } = discoveryFixture();
  add('other', spawnedAt + 400, 'same prompt', '/tmp/other-game');
  assert.equal(discoverTurnSession(home, '/tmp/other-game', spawnedAt, 'same prompt'), 'session_other');
  assert.equal(discoverTurnSession(home, DISCOVER_WORKDIR, spawnedAt, 'same prompt'), null);
  // The agent dir spelled with a trailing slash still matches the index row.
  assert.equal(discoverTurnSession(home, '/tmp/other-game/', spawnedAt, 'same prompt'), 'session_other');
});

test('no index, an unreadable log, or a torn index line yields null', () => {
  const { home, spawnedAt, add } = discoveryFixture();
  assert.equal(discoverTurnSession('/nonexistent-abcdef', DISCOVER_WORKDIR, spawnedAt, 'x'), null);
  // Indexed but the wire.jsonl was never written.
  const id = `session_nowrite`;
  const dir = path.join(home, 'sessions', 'wd_game_0123456789ab', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(home, 'session_index.jsonl'), `${JSON.stringify({ sessionId: id, sessionDir: dir, workDir: DISCOVER_WORKDIR })}\n`);
  assert.equal(discoverTurnSession(home, DISCOVER_WORKDIR, spawnedAt, 'x'), null);
  // A torn tail line is skipped, not fatal.
  fs.appendFileSync(path.join(home, 'session_index.jsonl'), '{"sessionId":"session_tor');
  const fresh = add('fresh', spawnedAt + 400, 'x');
  assert.equal(discoverTurnSession(home, DISCOVER_WORKDIR, spawnedAt, 'x'), fresh);
});

// A handle whose only turn died before the resume hint knows no id. If the DB
// row gains one out of band (a recovery stamp — the very id the hint would
// have carried), the next ensure() must adopt it; otherwise the next turn
// spawns FRESH and the CLI's new session overwrites the stamp, stranding the
// conversation it pointed to. Observed through usage(): adoption is what lets
// the totals be read out of the stamped session's log.
test('a handle that never learned an id adopts one stamped into the DB', async () => {
  const KIMI_ID = 'session_72bb3c42-303e-480e-89eb-564964409064';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-kimi-adopt-'));
  const dir = path.join(home, 'sessions', 'wd_x_0123456789ab', KIMI_ID);
  fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'session_index.jsonl'),
    `${JSON.stringify({ sessionId: KIMI_ID, sessionDir: dir, workDir: '/tmp/x' })}\n`,
  );
  fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), [
    '{"type":"usage.record","agentId":"main","usage":{"inputOther":10,"output":5,"inputCacheRead":0,"inputCacheCreation":0},"time":1}',
    '',
  ].join('\n'));

  const prevHome = process.env.HERMIT_KIMI_HOME;
  process.env.HERMIT_KIMI_HOME = home;
  const rt = new KimiCodeRuntime();
  const emit = () => {};
  const base = { id: 'sess-adopt-test', agentName: 'x', agentDirectory: '/tmp', model: null, credentialId: null };
  try {
    const h1 = await rt.ensure({ ...base, externalSessionId: null }, emit);
    assert.equal(await rt.usage(h1), null, 'no id, no totals');
    // The row is stamped out of band; the next submit's ensure() adopts it.
    const adopted = await rt.ensure({ ...base, externalSessionId: KIMI_ID }, emit);
    assert.equal((await rt.usage(adopted))?.totalTokens, 15, 'the stamped id was not adopted');
    // A handle that HAS an id ignores the row — the hint is authoritative.
    const keep = await rt.ensure({ ...base, externalSessionId: 'session_00000000-0000-4000-8000-000000000000' }, emit);
    assert.equal((await rt.usage(keep))?.totalTokens, 15, "the row's value displaced the learned id");
    // A non-kimi id in the row is not adopted.
    const other = { ...base, id: 'sess-adopt-test-2' };
    const h2 = await rt.ensure({ ...other, externalSessionId: null }, emit);
    assert.equal(await rt.usage(h2), null);
    const notKimi = await rt.ensure({ ...other, externalSessionId: 'a-claude-uuid' }, emit);
    assert.equal(await rt.usage(notKimi), null, 'a foreign id was adopted');
    await rt.stop(notKimi, 'kill');
  } finally {
    if (prevHome === undefined) delete process.env.HERMIT_KIMI_HOME;
    else process.env.HERMIT_KIMI_HOME = prevHome;
    await rt.stop({ sessionId: base.id, externalSessionId: '' }, 'kill');
  }
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

// …and skipping it must not also step OVER it. Advancing the offset to the
// file's size would lose that record forever — a number quietly too low, with
// no symptom to notice.
test('a half-written tail line is re-read once it is complete', () => {
  const { home, wire, sessionId } = fixture();
  const partial = '{"type":"usage.record","agentId":"main","usage":{"inputOth';
  fs.writeFileSync(wire, TURN_1 + partial);

  const first = scanWire(wireFileFor(home, sessionId)!, 0, null)!;
  assert.equal(first.totals.input, 4090 + 16896);
  assert.equal(first.offset, Buffer.byteLength(TURN_1), 'the offset stopped past the partial line');

  // The writer finishes the line.
  fs.writeFileSync(wire, TURN_1 + TURN_2);
  const second = scanWire(wire, first.offset, first.totals)!;
  assert.equal(second.totals.input, 4090 + 16896 + 2303 + 18176);
});

// A log holding nothing but a partial first line has no complete record to
// count and nowhere safe to move the offset to.
test('a log with no complete line yet leaves the offset alone', () => {
  const { home, wire, sessionId } = fixture();
  fs.writeFileSync(wire, '{"type":"usage.rec');
  assert.equal(scanWire(wireFileFor(home, sessionId)!, 0, null), null);
});

test('a log that does not exist yet is not an error', () => {
  const { home, sessionId } = fixture();
  assert.equal(scanWire(wireFileFor(home, sessionId)!, 0, null), null);
});

// The cheap-repeat path storedUsage() depends on: a session with no live child
// is not being written to, so the second scan must cost a stat and stop — not
// re-read a multi-megabyte log on every 8-second snapshot tick.
test('re-scanning an unchanged log reads nothing and keeps the totals', () => {
  const { home, wire, sessionId } = fixture();
  fs.writeFileSync(wire, TURN_1);
  const first = scanWire(wireFileFor(home, sessionId)!, 0, null)!;

  const again = scanWire(wire, first.offset, first.totals)!;
  assert.deepEqual(again.totals, first.totals);
  assert.equal(again.offset, first.offset);
});

// ── what the chat is told when a turn dies ───────────────────────────────────
// The 2026-08-28 session cmtcdtw7 lost five turns to the silence watchdog, and
// every one of them was reported as `kimi exited SIGKILL` with a slab of
// unrelated `ls` output under it. Naming the killer is the whole point.

const KILL = { code: null, signal: 'SIGKILL', sawContent: true, stderrTail: 'total 48\ndrwx------ agents\n' };

test('a watchdog kill says the gateway did it, and drops the stderr tail', () => {
  const m = turnFailureMessage({ ...KILL, silenceKill: { stdoutQuietMs: 15 * 60_000, wireQuietMs: 16 * 60_000 } });
  assert.match(m, /gateway stopped this turn/);
  assert.match(m, /nothing for 15min/);
  assert.match(m, /quiet for 16min/);
  assert.ok(!m.includes('drwx'), 'tool output must not be pasted under the reason');
  assert.ok(!m.includes('SIGKILL'), 'the signal is our own doing, not a diagnosis');
  assert.match(m, /Send another message/);
});

test('a watchdog kill with no session log says so rather than inventing a number', () => {
  const m = turnFailureMessage({ ...KILL, silenceKill: { stdoutQuietMs: 15 * 60_000, wireQuietMs: null } });
  assert.match(m, /no session log on disk/);
  assert.ok(!/quiet for/.test(m));
});

test('a real crash keeps the CLI reason, labelled and capped', () => {
  const m = turnFailureMessage({ code: 1, signal: null, sawContent: false, silenceKill: null, stderrTail: 'x'.repeat(900) + 'ERR boom' });
  assert.match(m, /kimi exited 1 — the turn produced nothing/);
  assert.match(m, /last stderr/);
  assert.match(m, /ERR boom$/);
  assert.ok(m.length < 600, `capped, got ${m.length}`);
});

test('a crash with nothing on stderr adds no empty label', () => {
  const m = turnFailureMessage({ code: 127, signal: null, sawContent: false, silenceKill: null, stderrTail: '   \n' });
  assert.equal(m, 'kimi exited 127 — the turn produced nothing');
});
