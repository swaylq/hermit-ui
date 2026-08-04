import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntime } from './runtime-resolve';

test('nothing set anywhere falls back to claude-tmux', () => {
  assert.deepEqual(resolveRuntime(null, null), {
    runtime: 'claude-tmux', runtimeProvider: null, runtimeModel: null,
  });
  assert.deepEqual(resolveRuntime({}, {}), {
    runtime: 'claude-tmux', runtimeProvider: null, runtimeModel: null,
  });
});

test('a session with no choice inherits the agent wholesale', () => {
  const out = resolveRuntime(
    { runtime: null },
    { runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x' },
  );
  assert.deepEqual(out, {
    runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x',
  });
});

test("a session's own choice beats the agent default", () => {
  const out = resolveRuntime(
    { runtime: 'claude-tmux' },
    { runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x' },
  );
  assert.equal(out.runtime, 'claude-tmux');
});

test('switching backend does NOT inherit the other backend\'s provider/model', () => {
  // The agent is on pi with a deepseek model; this session chose claude. Carrying
  // provider/model over would hand claude a deepseek model id.
  const out = resolveRuntime(
    { runtime: 'claude-tmux' },
    { runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x' },
  );
  assert.deepEqual(out, {
    runtime: 'claude-tmux', runtimeProvider: null, runtimeModel: null,
  });
});

test('same backend as the agent inherits provider/model when unset', () => {
  const out = resolveRuntime(
    { runtime: 'pi-rpc' },
    { runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x' },
  );
  assert.deepEqual(out, {
    runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x',
  });
});

test('a session may override just the model', () => {
  const out = resolveRuntime(
    { runtime: 'pi-rpc', runtimeModel: 'moonshotai/kimi-k3' },
    { runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x' },
  );
  assert.deepEqual(out, {
    runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'moonshotai/kimi-k3',
  });
});

test('a pi session on an agent that has no pi settings still resolves', () => {
  const out = resolveRuntime({ runtime: 'pi-rpc' }, { runtime: 'claude-tmux' });
  assert.deepEqual(out, { runtime: 'pi-rpc', runtimeProvider: null, runtimeModel: null });
});
