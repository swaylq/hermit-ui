import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CodexExecRuntime, readRolloutTokens, findRolloutFile, resolveCodexModel,
  clampEffort, codexChildEnv, codexShellIsolationConfig, hermitMcpConfigFor, httpsTransportConfig,
  serviceTierConfig,
  client,
} from './codex-exec';

// ── the rollout file, which is how a restarted gateway gets its baseline ──────

function fixtureHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const dir = path.join(home, 'sessions', '2026', '08', '11');
  fs.mkdirSync(dir, { recursive: true });
  return home;
}

const tokenLine = (
  total: [number, number],
  last: [number, number],
  lastTotal = last[0] + last[1],
) => JSON.stringify({
  timestamp: '2026-08-11T12:22:58.256Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: total[0], output_tokens: total[1], total_tokens: total[0] + total[1] },
      last_token_usage: { input_tokens: last[0], output_tokens: last[1], total_tokens: lastTotal },
      model_context_window: 258_400,
    },
  },
});

test('the last token_count in a rollout is the one that counts', () => {
  const home = fixtureHome();
  const file = path.join(home, 'sessions', '2026', '08', '11', 'rollout-2026-08-11T20-22-33-thread-abc.jsonl');
  fs.writeFileSync(file, [
    '{"type":"session_meta"}',
    tokenLine([28_916, 116], [28_916, 116]),
    '{"type":"response_item"}',
    tokenLine([58_065, 134], [14_588, 9]),
    '',
  ].join('\n'));

  const out = readRolloutTokens(file);
  assert.deepEqual(out?.total, { input: 58_065, output: 134 });
  assert.deepEqual(out?.lastTurn, { contextTokens: 14_588, outputTokens: 9 });
});

test('runtime context follows the latest model call inside a tool-heavy turn', async (t) => {
  const home = fixtureHome();
  const threadId = 'thread-agentic-turn';
  const file = path.join(home, 'sessions', '2026', '08', '11', `rollout-live-${threadId}.jsonl`);
  fs.writeFileSync(file, [
    '{"type":"session_meta"}',
    tokenLine([11_308_234, 58_070], [215_073, 1_810]),
    '',
  ].join('\n'));

  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const runtime = new CodexExecRuntime();
  let handle: { sessionId: string; externalSessionId: string } | null = null;
  t.after(async () => {
    if (handle) await runtime.stop(handle, 'kill');
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  handle = await runtime.ensure({
    id: `usage-test-${Date.now()}`,
    agentName: 'test',
    agentDirectory: home,
    externalSessionId: threadId,
    model: 'gpt-5.6-sol',
  }, () => {});

  assert.equal((await runtime.usage(handle))?.contextTokens, 215_073);

  // These are from the production incident: one user turn made several model
  // calls, then compacted. The whole turn spent 803,673 input tokens, but its
  // final prompt — the actual context occupancy — was only 26,630.
  fs.appendFileSync(file, [
    tokenLine([11_525_135, 58_576], [216_901, 506]),
    tokenLine([11_743_668, 58_663], [218_533, 87]),
    tokenLine([11_966_062, 58_731], [222_394, 68]),
    tokenLine([11_966_062, 58_731], [0, 0], 15_956),
    '',
  ].join('\n'));
  assert.equal((await runtime.usage(handle))?.contextTokens, 15_956);

  fs.appendFileSync(file, [
    tokenLine([11_988_679, 58_990], [22_617, 259]),
    tokenLine([12_111_907, 61_219], [26_630, 512]),
    '',
  ].join('\n'));
  const current = await runtime.usage(handle);
  assert.equal(current?.contextTokens, 26_630);
  assert.equal(current?.outputTokens, 512);
  assert.equal(current?.totalTokens, 12_173_126);
  assert.notEqual(current?.contextTokens, 12_111_907 - 11_308_234);

  await runtime.stop(handle, 'hibernate');
  const persistedHandle = { sessionId: handle.sessionId, externalSessionId: threadId };
  assert.equal(await runtime.usage(persistedHandle), null);
  assert.equal((await runtime.storedUsage(persistedHandle))?.contextTokens, 26_630);
});

test('a persisted thread repairs context immediately after a gateway restart', async (t) => {
  const home = fixtureHome();
  const threadId = 'thread-after-gateway-restart';
  const file = path.join(home, 'sessions', '2026', '08', '11', `rollout-idle-${threadId}.jsonl`);
  fs.writeFileSync(file, `${tokenLine([12_111_907, 61_219], [26_630, 512])}\n`);

  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Deliberately do not call ensure(): this is the exact state after the
  // gateway process restarts and its live handle map is empty.
  const runtime = new CodexExecRuntime();
  const offlineHandle = { sessionId: 'offline-session', externalSessionId: threadId };
  assert.equal(await runtime.usage(offlineHandle), null);
  const current = await runtime.storedUsage(offlineHandle);
  assert.deepEqual(current, {
    contextTokens: 26_630,
    outputTokens: 512,
    totalTokens: 12_173_126,
    costUsd: null,
  });
});

// The production incident: a session ran on claude-tmux, was switched to codex,
// and arrived here still carrying the CLAUDE transcript uuid in the one
// externalSessionId slot the backends share. codex answered
// `thread/resume: no rollout found ... (code -32600)` and — because a foreign id
// never becomes resumable — did so on every retry after it. The chat was dead.
test('an id no rollout backs starts a fresh thread instead of failing forever', async (t) => {
  const home = fixtureHome();
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const runtime = new CodexExecRuntime();
  let handle: { sessionId: string; externalSessionId: string } | null = null;
  t.after(async () => {
    if (handle) await runtime.stop(handle, 'kill');
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  handle = await runtime.ensure({
    id: `foreign-id-${Date.now()}`,
    agentName: 'test',
    agentDirectory: home,
    externalSessionId: 'dcc075e8-4b58-4d9e-82b3-df400a8a797e', // a claude uuid
    model: 'gpt-5.6-sol',
  }, () => {});

  // Empty, not the foreign id: nothing was resumed, so there is no thread id yet
  // — codex reports its own on the first turn and that is what gets stamped.
  assert.equal(handle.externalSessionId, '');
});

test('a thread whose rollout is on disk still resumes', async (t) => {
  const home = fixtureHome();
  const threadId = '019ff0c6-45a0-7c03-ae54-7d8b99451e89';
  fs.writeFileSync(
    path.join(home, 'sessions', '2026', '08', '11', `rollout-2026-08-11T20-22-33-${threadId}.jsonl`),
    `${tokenLine([12_111_907, 61_219], [26_630, 512])}\n`,
  );

  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const runtime = new CodexExecRuntime();
  let handle: { sessionId: string; externalSessionId: string } | null = null;
  t.after(async () => {
    if (handle) await runtime.stop(handle, 'kill');
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  handle = await runtime.ensure({
    id: `own-id-${Date.now()}`,
    agentName: 'test',
    agentDirectory: home,
    externalSessionId: threadId,
    model: 'gpt-5.6-sol',
  }, () => {});

  assert.equal(handle.externalSessionId, threadId);
});

test('cumulative-only rollout data does not masquerade as current context', (t) => {
  const home = fixtureHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'sessions', '2026', '08', '11', 'rollout-old-format.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900_000, output_tokens: 2_000 } } },
  })}\n`);
  assert.deepEqual(readRolloutTokens(file), {
    total: { input: 900_000, output: 2_000 },
    lastTurn: null,
  });
});

test('a partially-written final token record falls back to the prior complete one', (t) => {
  const home = fixtureHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'sessions', '2026', '08', '11', 'rollout-mid-append.jsonl');
  fs.writeFileSync(file, `${tokenLine([100, 10], [80, 4])}\n{"type":"event_msg","payload":{"type":"token_count"`);
  assert.deepEqual(readRolloutTokens(file)?.lastTurn, { contextTokens: 80, outputTokens: 4 });
});

// Only the tail is read, so the first line in the window is usually a fragment.
// It must be skipped, not throw.
test('a truncated leading line does not break the read', () => {
  const home = fixtureHome();
  const file = path.join(home, 'sessions', '2026', '08', '11', 'rollout-x-thread-def.jsonl');
  fs.writeFileSync(file, ['ken_count":{"garbage', tokenLine([10, 2], [4, 1]), ''].join('\n'));
  assert.deepEqual(readRolloutTokens(file)?.lastTurn, { contextTokens: 4, outputTokens: 1 });
});

test('a rollout with no token_count reports nothing', () => {
  const home = fixtureHome();
  const file = path.join(home, 'sessions', '2026', '08', '11', 'rollout-y-thread-ghi.jsonl');
  fs.writeFileSync(file, '{"type":"session_meta"}\n');
  assert.equal(readRolloutTokens(file), null);
});

test('a missing rollout reports nothing rather than throwing', () => {
  assert.equal(readRolloutTokens('/nope/does/not/exist.jsonl'), null);
});

test('a thread is found by id under the dated directories', () => {
  const home = fixtureHome();
  const dir = path.join(home, 'sessions', '2026', '08', '11');
  const file = path.join(dir, 'rollout-2026-08-11T20-22-33-019ff0c6-45a0-7c03-ae54-7d8b99451e89.jsonl');
  fs.writeFileSync(file, '\n');
  assert.equal(findRolloutFile('019ff0c6-45a0-7c03-ae54-7d8b99451e89', home), file);
  assert.equal(findRolloutFile('no-such-thread', home), null);
});

// Newest-day-first, because a resumed thread appends to its ORIGINAL file and
// the common case is a session from today or yesterday.
test('the newest day is searched first', () => {
  const home = fixtureHome();
  const older = path.join(home, 'sessions', '2026', '08', '10');
  const newer = path.join(home, 'sessions', '2026', '08', '12');
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(older, 'rollout-old-shared.jsonl'), '\n');
  fs.writeFileSync(path.join(newer, 'rollout-new-shared.jsonl'), '\n');
  assert.equal(findRolloutFile('shared', home), path.join(newer, 'rollout-new-shared.jsonl'));
});

test('a codex home that does not exist is not an error', () => {
  assert.equal(findRolloutFile('x', '/nope/no/codex/home'), null);
});

// ── model + effort defaults ──────────────────────────────────────────────────

const sessionFor = (model: string | null) => ({
  id: 's', agentName: 'a', agentDirectory: '/tmp', externalSessionId: null, model,
} as Parameters<typeof resolveCodexModel>[0]);

// codex's own default effort for this model is LOW, so a session left alone was
// running at the bottom of the ladder. The fleet default is the top of the
// depth dial instead.
test('a session that pins no model runs the fleet default', () => {
  const prev = process.env.HERMIT_CODEX_MODEL;
  delete process.env.HERMIT_CODEX_MODEL;
  try {
    assert.equal(resolveCodexModel(sessionFor(null)), 'gpt-6-astra');
    assert.equal(resolveCodexModel(sessionFor('   ')), 'gpt-6-astra');
  } finally {
    if (prev === undefined) delete process.env.HERMIT_CODEX_MODEL;
    else process.env.HERMIT_CODEX_MODEL = prev;
  }
});

test('a session that pins a model wins over the default', () => {
  assert.equal(resolveCodexModel(sessionFor('gpt-5.4-mini')), 'gpt-5.4-mini');
});

test('the machine env sits between the session and the fleet default', () => {
  const prev = process.env.HERMIT_CODEX_MODEL;
  process.env.HERMIT_CODEX_MODEL = 'gpt-5.5';
  try {
    assert.equal(resolveCodexModel(sessionFor(null)), 'gpt-5.5');
    // ...but never over an explicit per-session choice.
    assert.equal(resolveCodexModel(sessionFor('gpt-5.6-terra')), 'gpt-5.6-terra');
  } finally {
    if (prev === undefined) delete process.env.HERMIT_CODEX_MODEL;
    else process.env.HERMIT_CODEX_MODEL = prev;
  }
});

// ── effort clamping ──────────────────────────────────────────────────────────
//
// An unsupported model+effort pair is a HARD failure, not a downgrade —
// measured: `gpt-5.4` with `ultra` dies "Codex Exec exited with code 1" before
// the model sees the prompt. A session can pin its own model from the
// dashboard, so the fleet default has to bend to it.

test('the default model takes the top of the ladder unchanged', () => {
  assert.equal(clampEffort('ultra', 'gpt-6-astra'), 'ultra');
  assert.equal(clampEffort('ultra', 'gpt-5.6-sol'), 'ultra');
  assert.equal(clampEffort('ultra', 'gpt-5.6-terra'), 'ultra');
});

test('the one 5.6 model without ultra is lowered to its own ceiling', () => {
  assert.equal(clampEffort('ultra', 'gpt-5.6-luna'), 'max');
});

test('older models are lowered to xhigh rather than failing every turn', () => {
  assert.equal(clampEffort('ultra', 'gpt-5.5'), 'xhigh');
  assert.equal(clampEffort('ultra', 'gpt-5.4'), 'xhigh');
  assert.equal(clampEffort('ultra', 'gpt-5.4-mini'), 'xhigh');
  assert.equal(clampEffort('max', 'gpt-5.4'), 'xhigh');
});

// Ordering: the longest prefix has to win, or the small model picks up the
// family ceiling.
test('the small model resolves to its own entry, not a shorter prefix', () => {
  assert.equal(clampEffort('ultra', 'gpt-5.3-codex-spark'), 'xhigh');
});

test('an effort already within the ceiling is untouched', () => {
  assert.equal(clampEffort('high', 'gpt-5.4'), 'high');
  assert.equal(clampEffort('low', 'gpt-5.6-sol'), 'low');
  assert.equal(clampEffort('max', 'gpt-5.6-luna'), 'max');
});

// A new frontier model is likelier to support more than less; capping it on a
// guess would silently pin it low forever, while a wrong guess fails loudly
// with codex's own message.
test('an unknown model is passed through unclamped', () => {
  assert.equal(clampEffort('ultra', 'gpt-6-unreleased'), 'ultra');
});

test('an effort codex knows and we do not is left for codex to judge', () => {
  assert.equal(clampEffort('turbo', 'gpt-5.4'), 'turbo');
});

test('case and padding do not defeat the clamp', () => {
  assert.equal(clampEffort('ultra', '  GPT-5.4  '), 'xhigh');
});

// ── hermit tools ─────────────────────────────────────────────────────────────
//
// Without these a codex session has only the shell and apply_patch, and the
// failure is not a missing-tool error — it is the model improvising. Observed
// on a real session: asked to send a file back, it grepped the repo for
// attach_file, read mcp-stub.cjs, tried to hand-drive the stub over raw
// JSON-RPC, then told the user the file had been sent. Nothing was.

test('a codex session is given the hermit MCP server', () => {
  const cfg = hermitMcpConfigFor({
    id: 'sess-1', agentName: 'a', agentDirectory: '/tmp', externalSessionId: null, model: null, mode: null,
  });
  const hermit = (cfg.mcp_servers as any).hermit;
  assert.equal(hermit.command, 'node');
  assert.match(String(hermit.args[0]), /mcp-stub\.cjs$/);
});

// The stub reads its identity from the env; without the session id it cannot
// post an attachment anywhere, and the tool would fail at the last step.
test('the stub inherits identity by variable name, with no values in Codex argv config', () => {
  const cfg = hermitMcpConfigFor({
    id: 'sess-42', agentName: 'a', agentDirectory: '/tmp', externalSessionId: null, model: null, mode: null,
  });
  const hermit = (cfg.mcp_servers as any).hermit;
  // HERMIT_CHAT_ONLY joined the list so a pure-chat codex session's stub drops
  // its three cron tools. Still an exact match on purpose: this list is what
  // crosses into the MCP child, so it should be read deliberately, not grown by
  // accident.
  assert.deepEqual(hermit.env_vars, [
    'HERMIT_SESSION_ID', 'HERMIT_DASHBOARD_URL', 'HERMIT_KEY',
    'HERMIT_CHAT_ONLY', 'HERMIT_AGENT_DIR',
  ]);
  assert.equal(hermit.env, undefined);
  assert.doesNotMatch(JSON.stringify(cfg), /sess-42/);
  const child = codexChildEnv({
    id: 'sess-42', agentName: 'a', agentDirectory: '/tmp', externalSessionId: null, model: null, mode: null,
  });
  assert.equal(child.HERMIT_SESSION_ID, 'sess-42');
  assert.ok(Object.hasOwn(child, 'HERMIT_KEY'));
  assert.equal(Object.hasOwn(child, 'ASST_KEY'), false, 'gateway source key is not inherited');
});

test('ordinary Codex shell tools cannot inherit the MCP-only key', () => {
  const cfg = codexShellIsolationConfig() as any;
  assert.equal(cfg.allow_login_shell, false, 'a login shell could reload the key from a profile');
  assert.deepEqual(cfg.shell_environment_policy.exclude, ['HERMIT_KEY']);
});

// `ask` blocks until a human clicks a button, up to the stub's 4h ceiling. A
// default tool timeout would kill it long before, and the answer would land on
// a call that no longer exists.
test('the tool timeout clears the ask tool ceiling', () => {
  const cfg = hermitMcpConfigFor({
    id: 's', agentName: 'a', agentDirectory: '/tmp', externalSessionId: null, model: null, mode: null,
  });
  assert.ok((cfg.mcp_servers as any).hermit.tool_timeout_sec >= 4 * 3600);
});

// ── transport ────────────────────────────────────────────────────────────────
//
// codex prefers a WebSockets transport that some fleet networks cut mid-turn;
// each hit costs 5 reconnects before the HTTPS fallback, every turn, because
// exec-per-turn never remembers the fallback. The custom provider forces HTTPS
// from the start. See httpsTransportConfig's own comment for the measurements.

test('the https provider turns websockets off and keeps web search on', () => {
  const previous = process.env.HERMIT_CODEX_WEBSOCKETS;
  delete process.env.HERMIT_CODEX_WEBSOCKETS;
  try {
    const cfg = httpsTransportConfig();
    assert.equal(cfg.model_provider, 'openai_https');
    const provider = (cfg.model_providers as any).openai_https;
    assert.equal(provider.supports_websockets, false);
    // A custom provider defaults this to false; losing it would silently strip
    // WebSearch from every codex session.
    assert.equal(provider.supports_standalone_web_search, true);
    // ChatGPT-plan routing, not the API-key endpoint — billing must not move.
    assert.equal(provider.requires_openai_auth, true);
    assert.match(String(provider.base_url), /^https:\/\/chatgpt\.com\//);
  } finally {
    if (previous === undefined) delete process.env.HERMIT_CODEX_WEBSOCKETS;
    else process.env.HERMIT_CODEX_WEBSOCKETS = previous;
  }
});

test('the version header rides along, matching the vendored CLI', () => {
  const previous = process.env.HERMIT_CODEX_WEBSOCKETS;
  delete process.env.HERMIT_CODEX_WEBSOCKETS;
  try {
    const provider = (httpsTransportConfig().model_providers as any).openai_https;
    assert.match(String(provider.http_headers?.version), /^\d+\.\d+\.\d+/);
  } finally {
    if (previous === undefined) delete process.env.HERMIT_CODEX_WEBSOCKETS;
    else process.env.HERMIT_CODEX_WEBSOCKETS = previous;
  }
});

test('HERMIT_CODEX_WEBSOCKETS=1 restores the default transport', () => {
  const previous = process.env.HERMIT_CODEX_WEBSOCKETS;
  process.env.HERMIT_CODEX_WEBSOCKETS = '1';
  try {
    assert.deepEqual(httpsTransportConfig(), {});
  } finally {
    if (previous === undefined) delete process.env.HERMIT_CODEX_WEBSOCKETS;
    else process.env.HERMIT_CODEX_WEBSOCKETS = previous;
  }
});

// ── service tier ─────────────────────────────────────────────────────────────
//
// "1.5x speed, increased usage" in codex's own catalog. Unlike effort, a model
// that does not offer the tier is not a failure — codex warns and drops it — so
// there is no per-model table here to go stale.

test('the fleet asks codex for the fast queue', () => {
  const previous = process.env.HERMIT_CODEX_SERVICE_TIER;
  delete process.env.HERMIT_CODEX_SERVICE_TIER;
  try {
    assert.deepEqual(serviceTierConfig(), { service_tier: 'fast' });
  } finally {
    if (previous === undefined) delete process.env.HERMIT_CODEX_SERVICE_TIER;
    else process.env.HERMIT_CODEX_SERVICE_TIER = previous;
  }
});

// The ordinary queue has no name to send: you ask for it by sending no tier at
// all. A machine that set the env to 'default' and still got 'default' on the
// wire would have codex reject a tier it never heard of.
test('a machine can take the ordinary queue back', () => {
  const previous = process.env.HERMIT_CODEX_SERVICE_TIER;
  try {
    process.env.HERMIT_CODEX_SERVICE_TIER = 'default';
    assert.deepEqual(serviceTierConfig(), {});
    process.env.HERMIT_CODEX_SERVICE_TIER = '';
    assert.deepEqual(serviceTierConfig(), {});
  } finally {
    if (previous === undefined) delete process.env.HERMIT_CODEX_SERVICE_TIER;
    else process.env.HERMIT_CODEX_SERVICE_TIER = previous;
  }
});

// ── the JSONL repair, which is one line and would fail silently ──────────────

// Without it, one U+2028 anywhere in a turn's output kills the turn (see
// codex-jsonl-repair.ts). The wrap is a single call inside `client()`, and every
// test in codex-jsonl-repair.test.ts installs the wrap itself — so deleting that
// call reinstates the original bug with the whole suite still green. This is the
// test that goes red instead.
test('every codex client is built with the JSONL repair already installed', () => {
  const exec = (client({
    id: 'sess-1', agentName: 'a', agentDirectory: '/tmp', externalSessionId: null, model: null, mode: null,
  }) as unknown as { exec: object }).exec;

  assert.ok(Object.hasOwn(exec, 'run'), 'run is the SDK prototype method unless someone wrapped it');
});

// The wiring itself, not just the helper: deleting the emitNoticeOnce call in
// codex-exec's event loop must make a test go red, otherwise the dedupe only
// exists on paper. A fake thread feeds the loop three copies of the same
// non-fatal error; the chat must see exactly one.
test('a repeated non-fatal notice reaches the chat once per session', async (t) => {
  const home = fixtureHome();
  const runtime = new CodexExecRuntime();
  const emitted: Array<{ role: string; text: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handle: any = null;
  t.after(async () => {
    if (handle) await runtime.stop(handle, 'kill');
    fs.rmSync(home, { recursive: true, force: true });
  });
  handle = await runtime.ensure({
    id: `notice-dedupe-${Date.now()}`,
    agentName: 'test',
    agentDirectory: home,
    externalSessionId: null,
    model: 'gpt-5.6-sol',
  }, (item) => emitted.push({
    role: item.role,
    text: String((item.content as Array<{ text?: string }>)[0]?.text ?? ''),
  }));

  const notice = () => ({
    type: 'item.completed',
    item: { id: 'item_3', type: 'error', message: 'Heads up: long thread' },
  });
  (handle as { thread: unknown }).thread = {    id: 'thread-fake',
    runStreamed: async () => ({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-fake' };
        yield notice();
        yield notice();
        yield notice();
        yield {
          type: 'item.completed',
          item: { id: 'item_4', type: 'agent_message', text: 'done' },
        };
      })(),
    }),
  };

  assert.equal(await runtime.submit(handle, 'hi', []), true);
  // The turn is consumed in the background; wait for it to drain.
  for (let i = 0; i < 100 && (await runtime.isWorking(handle)); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const notices = emitted.filter((e) => e.text.startsWith('[codex error]'));
  assert.equal(notices.length, 1, 'three identical notices, one chat row');
  assert.ok(
    emitted.some((e) => e.text === 'done'),
    'ordinary content after the notice still lands',
  );

  // A second turn on the same session: still suppressed — the dedupe lives on
  // the handle, not on the turn.
  assert.equal(await runtime.submit(handle, 'again', []), true);
  for (let i = 0; i < 100 && (await runtime.isWorking(handle)); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(
    emitted.filter((e) => e.text.startsWith('[codex error]')).length,
    1,
    'the next turn does not re-show it either',
  );
});
