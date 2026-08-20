import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntime, runtimeContextOf, type RuntimeContext } from './runtime-resolve';

// A machine with two composed backends and the credentials behind them.
const CTX: RuntimeContext = {
  backends: {
    disabled: [],
    instances: [
      { id: 'pi-hyqubit', harness: 'pi-rpc', credentialId: 'hyqubit', label: 'pi · hyqubit' },
      { id: 'prime-kimi', harness: 'prime-rpc', credentialId: 'kimi', label: 'prime · Kimi', model: 'kimi-k3' },
    ],
  },
  credentials: [
    {
      id: 'hyqubit', label: 'hyqubit', provider: 'hyqubit', api: 'anthropic-messages',
      baseUrl: 'https://litellm.hyqubit.com', models: ['claude-opus-5', 'claude-sonnet-5'],
    },
    {
      id: 'kimi', label: 'Kimi', provider: 'moonshotai-cn', api: 'anthropic-messages',
      baseUrl: 'https://api.moonshot.cn/anthropic', models: ['kimi-k3'],
    },
  ],
};

test('nothing set anywhere falls back to claude-tmux', () => {
  assert.deepEqual(resolveRuntime(null, null), {
    backendId: 'claude-tmux', runtime: 'claude-tmux', runtimeCredentialId: null,
    runtimeProvider: null, runtimeModel: null, runtimeMode: null,
  });
  assert.deepEqual(resolveRuntime({}, {}), {
    backendId: 'claude-tmux', runtime: 'claude-tmux', runtimeCredentialId: null,
    runtimeProvider: null, runtimeModel: null, runtimeMode: null,
  });
});

// The whole point of the credential split: "pi + hyqubit" already knows which
// endpoint and which model it means, with nothing pinned anywhere.
test('a composed backend supplies its own provider and model', () => {
  const out = resolveRuntime({ runtime: 'pi-hyqubit' }, null, CTX);
  assert.deepEqual(out, {
    backendId: 'pi-hyqubit', runtime: 'pi-rpc', runtimeCredentialId: 'hyqubit',
    runtimeProvider: 'hyqubit', runtimeModel: 'claude-opus-5', runtimeMode: 'omp',
  });
});

test("the backend's own default model beats the credential's", () => {
  const out = resolveRuntime({ runtime: 'prime-kimi' }, null, CTX);
  assert.equal(out.runtimeModel, 'kimi-k3');
  assert.equal(out.runtimeCredentialId, 'kimi');
  // Only pi has modes. Prime has exactly one built-in tool, so a mode's tool
  // allowlist would name four that do not exist.
  assert.equal(out.runtimeMode, null);
});

test('a session with no choice inherits the agent wholesale', () => {
  const out = resolveRuntime(
    { runtime: null },
    { runtime: 'pi-hyqubit', runtimeModel: 'claude-sonnet-5', runtimeMode: 'ops' },
    CTX,
  );
  assert.equal(out.backendId, 'pi-hyqubit');
  assert.equal(out.runtimeModel, 'claude-sonnet-5');
  assert.equal(out.runtimeMode, 'ops');
});

test("a session's own choice beats the agent default", () => {
  const out = resolveRuntime({ runtime: 'claude-tmux' }, { runtime: 'pi-hyqubit' }, CTX);
  assert.equal(out.backendId, 'claude-tmux');
  assert.equal(out.runtime, 'claude-tmux');
});

test('switching backend does NOT inherit the other backend’s pins', () => {
  // The agent is on pi with a hyqubit model; this session chose claude.
  // Carrying provider/model over would hand claude a hyqubit model id.
  const out = resolveRuntime(
    { runtime: 'claude-tmux' },
    { runtime: 'pi-hyqubit', runtimeProvider: 'hyqubit', runtimeModel: 'claude-opus-5' },
    CTX,
  );
  assert.deepEqual(out, {
    backendId: 'claude-tmux', runtime: 'claude-tmux', runtimeCredentialId: null,
    runtimeProvider: null, runtimeModel: null, runtimeMode: null,
  });
});

test('two backends on the same harness are not the same backend', () => {
  const ctx: RuntimeContext = {
    ...CTX,
    backends: {
      disabled: [],
      instances: [
        ...CTX.backends!.instances!,
        { id: 'pi-kimi', harness: 'pi-rpc', credentialId: 'kimi', label: 'pi · Kimi' },
      ],
    },
  };
  // Same harness, different credential — so the agent's pins do not travel.
  const out = resolveRuntime(
    { runtime: 'pi-kimi' },
    { runtime: 'pi-hyqubit', runtimeModel: 'claude-opus-5' },
    ctx,
  );
  assert.equal(out.runtimeCredentialId, 'kimi');
  assert.equal(out.runtimeModel, 'kimi-k3');
});

test('a session may override just the model', () => {
  const out = resolveRuntime({ runtime: 'pi-hyqubit', runtimeModel: 'claude-sonnet-5' }, null, CTX);
  assert.equal(out.runtimeModel, 'claude-sonnet-5');
  assert.equal(out.runtimeProvider, 'hyqubit');
});

// ── legacy rows ─────────────────────────────────────────────────────────────

test('a row holding a bare harness name still runs', () => {
  const out = resolveRuntime({ runtime: 'pi-rpc' }, null, CTX);
  assert.equal(out.backendId, 'pi-hyqubit');
  assert.equal(out.runtime, 'pi-rpc');
  assert.equal(out.runtimeCredentialId, 'hyqubit');
});

test('a bare harness with no backend behind it falls to the floor, not to a broken spawn', () => {
  const out = resolveRuntime({ runtime: 'dsh-exec' }, null, CTX);
  assert.equal(out.backendId, 'claude-tmux');
});

// ── availability ────────────────────────────────────────────────────────────

test("an agent default the machine cannot run is substituted; a session's own choice is not", () => {
  const off: RuntimeContext = { ...CTX, backends: { ...CTX.backends!, disabled: ['pi-hyqubit'] } };
  // Inherited: re-pointed, because a new chat has to open on something runnable.
  assert.equal(resolveRuntime(null, { runtime: 'pi-hyqubit' }, off).backendId, 'claude-tmux');
  // Stated: left alone. Switching a backend off hides it from NEW work; it does
  // not stop what is already running, and relabelling it would make the header
  // chip a lie.
  assert.equal(resolveRuntime({ runtime: 'pi-hyqubit' }, null, off).backendId, 'pi-hyqubit');
});

test('a substituted agent default carries none of its pins', () => {
  const off: RuntimeContext = { ...CTX, backends: { ...CTX.backends!, disabled: ['pi-hyqubit'] } };
  const out = resolveRuntime(null, { runtime: 'pi-hyqubit', runtimeModel: 'claude-opus-5' }, off);
  assert.deepEqual(out, {
    backendId: 'claude-tmux', runtime: 'claude-tmux', runtimeCredentialId: null,
    runtimeProvider: null, runtimeModel: null, runtimeMode: null,
  });
});

// ── the context reader ──────────────────────────────────────────────────────

// Both halves come off one Machine row. Taking them together removes the class
// of bug where one is passed and the other forgotten, which would resolve a
// backend and then authenticate it with nothing.
test('runtimeContextOf reads both halves off one row', () => {
  const ctx = runtimeContextOf({
    backendsConfig: { disabled: [], instances: [{ id: 'pi-x', harness: 'pi-rpc', credentialId: 'x', label: 'pi' }] },
    modelProviders: [{ id: 'x', label: 'X', provider: 'x', api: 'anthropic-messages', baseUrl: 'https://x', models: ['m'] }],
  });
  assert.equal(ctx.backends?.instances?.length, 1);
  assert.equal(ctx.credentials.length, 1);
  assert.equal(resolveRuntime({ runtime: 'pi-x' }, null, ctx).runtimeModel, 'm');
});
