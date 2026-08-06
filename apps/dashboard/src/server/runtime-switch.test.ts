import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRuntimeSwitch } from './runtime-switch';

const claude = { runtime: 'claude-tmux', runtimeProvider: null, runtimeModel: null, runtimeMode: null };
const pi = (provider: string | null = null, model: string | null = null, mode: string | null = 'coding') => ({
  runtime: 'pi-rpc', runtimeProvider: provider, runtimeModel: model, runtimeMode: mode,
});

test('a mid-turn session refuses the switch', () => {
  const plan = planRuntimeSwitch({ state: 'working' }, claude, pi());
  assert.equal(plan.ok, false);
  assert.match(plan.ok === false ? plan.reason : '', /mid-turn/);
});

test('an idle session switches backends and needs the old process torn down', () => {
  assert.deepEqual(planRuntimeSwitch({ state: 'idle' }, claude, pi()), { ok: true, restart: true });
  assert.deepEqual(planRuntimeSwitch({ state: null }, pi(), claude), { ok: true, restart: true });
});

// pi passes provider+model to RpcClient when it spawns the child, so a session
// already talking to one model cannot be re-pointed without a fresh child.
test('re-pointing a pi session at a different model restarts it', () => {
  const plan = planRuntimeSwitch({ state: 'idle' }, pi('hyqubit', 'claude-opus-5'), pi('hyqubit', 'claude-sonnet-5'));
  assert.deepEqual(plan, { ok: true, restart: true });
});

test('a different pi provider restarts it too', () => {
  const plan = planRuntimeSwitch({ state: 'idle' }, pi('openrouter', 'x'), pi('hyqubit', 'x'));
  assert.deepEqual(plan, { ok: true, restart: true });
});

test('re-saving a pi session unchanged does not restart it', () => {
  const plan = planRuntimeSwitch({ state: 'idle' }, pi('hyqubit', 'claude-opus-5'), pi('hyqubit', 'claude-opus-5'));
  assert.deepEqual(plan, { ok: true, restart: false });
});

// Claude Code reads its model from the machine's ~/.claude/settings.json; these
// columns describe pi. Writing them on a claude session must not kill its pane.
test('provider/model churn on a claude session is inert', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    { runtime: 'claude-tmux', runtimeProvider: 'anthropic', runtimeModel: 'opus', runtimeMode: null },
    { runtime: 'claude-tmux', runtimeProvider: null, runtimeModel: null, runtimeMode: null },
  );
  assert.deepEqual(plan, { ok: true, restart: false });
});

test('null and undefined provider/model are the same absence', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    { runtime: 'pi-rpc', runtimeProvider: null, runtimeModel: null, runtimeMode: null },
    {
      runtime: 'pi-rpc',
      runtimeProvider: undefined as unknown as null,
      runtimeModel: undefined as unknown as null,
      runtimeMode: undefined as unknown as null,
    },
  );
  assert.deepEqual(plan, { ok: true, restart: false });
});

// A mode is nothing but spawn arguments — system prompt, tool allowlist, skills,
// extensions. A running child cannot adopt a new one, so changing it must tear
// the child down exactly like changing the model does.
test('changing the pi mode restarts the child', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    pi('hyqubit', 'claude-opus-5', 'coding'),
    pi('hyqubit', 'claude-opus-5', 'ops'),
  );
  assert.deepEqual(plan, { ok: true, restart: true });
});

test('same mode does not restart', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    pi('hyqubit', 'claude-opus-5', 'ops'),
    pi('hyqubit', 'claude-opus-5', 'ops'),
  );
  assert.deepEqual(plan, { ok: true, restart: false });
});

test('mode churn on a claude session is inert', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    { runtime: 'claude-tmux', runtimeProvider: null, runtimeModel: null, runtimeMode: 'ops' },
    { runtime: 'claude-tmux', runtimeProvider: null, runtimeModel: null, runtimeMode: 'coding' },
  );
  assert.deepEqual(plan, { ok: true, restart: false });
});
