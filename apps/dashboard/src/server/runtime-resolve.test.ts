import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntime } from './runtime-resolve';

test('nothing set anywhere falls back to claude-tmux', () => {
  assert.deepEqual(resolveRuntime(null, null), {
    runtime: 'claude-tmux', runtimeProvider: null, runtimeModel: null, runtimeMode: null,
  });
  assert.deepEqual(resolveRuntime({}, {}), {
    runtime: 'claude-tmux', runtimeProvider: null, runtimeModel: null, runtimeMode: null,
  });
});

test('a session with no choice inherits the agent wholesale', () => {
  const out = resolveRuntime(
    { runtime: null },
    { runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x', runtimeMode: 'ops' },
  );
  assert.deepEqual(out, {
    runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x', runtimeMode: 'ops',
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
    runtime: 'claude-tmux', runtimeProvider: null, runtimeModel: null, runtimeMode: null,
  });
});

test('same backend as the agent inherits provider/model when unset', () => {
  const out = resolveRuntime(
    { runtime: 'pi-rpc' },
    { runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x' },
  );
  assert.deepEqual(out, {
    runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x', runtimeMode: 'omp',
  });
});

test('a session may override just the model', () => {
  const out = resolveRuntime(
    { runtime: 'pi-rpc', runtimeModel: 'moonshotai/kimi-k3' },
    { runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x' },
  );
  assert.deepEqual(out, {
    runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'moonshotai/kimi-k3', runtimeMode: 'omp',
  });
});

test('a pi session on an agent that has no pi settings still resolves', () => {
  const out = resolveRuntime({ runtime: 'pi-rpc' }, { runtime: 'claude-tmux' });
  assert.deepEqual(out, {
    runtime: 'pi-rpc', runtimeProvider: null, runtimeModel: null, runtimeMode: 'omp',
  });
});

// ── mode ────────────────────────────────────────────────────────────────────

test('a pi session with no mode anywhere gets the default mode', () => {
  assert.equal(resolveRuntime({ runtime: 'pi-rpc' }, null).runtimeMode, 'omp');
});

test("a session's own mode beats the agent's", () => {
  const out = resolveRuntime(
    { runtime: 'pi-rpc', runtimeMode: 'ops' },
    { runtime: 'pi-rpc', runtimeMode: 'research' },
  );
  assert.equal(out.runtimeMode, 'ops');
});

test('claude-tmux never carries a mode, even when one is set', () => {
  // A mode is a pi spawn recipe. Handing one to the tmux path would be a value
  // the gateway has to remember to ignore; resolving to null removes the trap.
  assert.equal(resolveRuntime({ runtime: 'claude-tmux', runtimeMode: 'ops' }, null).runtimeMode, null);
  assert.equal(
    resolveRuntime(null, { runtime: 'claude-tmux', runtimeMode: 'ops' }).runtimeMode,
    null,
  );
});

test('switching from a pi agent to claude drops the inherited mode', () => {
  const out = resolveRuntime({ runtime: 'claude-tmux' }, { runtime: 'pi-rpc', runtimeMode: 'ops' });
  assert.equal(out.runtimeMode, null);
});

// omp was briefly its own backend before being folded into pi as an engine the
// mode selects. A session created in that window must still resolve to
// something that runs, rather than silently falling through to the tmux path.
test('a legacy omp-rpc session normalizes to pi', () => {
  const out = resolveRuntime({ runtime: 'omp-rpc' }, null);
  assert.equal(out.runtime, 'pi-rpc');
  assert.equal(out.runtimeMode, 'omp');
});

test('a legacy omp-rpc session keeps whatever mode it had', () => {
  assert.equal(
    resolveRuntime({ runtime: 'omp-rpc', runtimeMode: 'ops' }, null).runtimeMode,
    'ops',
  );
});

// ── what the machine actually offers (Settings → Backends) ──────────────────

// The reported case: a machine with Claude Code switched off and codex on. Every
// agent there defaults to claude-tmux (stored, or the fleet floor), so without
// this every inherited session resolved to a backend that machine does not run.
test('an inherited default the machine has switched off falls through to one it runs', () => {
  const codexOnly = { disabled: ['claude-tmux', 'pi-rpc', 'dsh-exec'] };
  assert.deepEqual(resolveRuntime(null, null, codexOnly), {
    runtime: 'codex-exec', runtimeProvider: null, runtimeModel: null, runtimeMode: null,
  });
  assert.equal(resolveRuntime({ runtime: null }, { runtime: 'claude-tmux' }, codexOnly).runtime, 'codex-exec');
});

// Off hides a backend from new work; it does not stop what is already on it, and
// reporting a running claude session as codex would make every header chip lie.
test("a session's own backend is never re-pointed, even when switched off", () => {
  const codexOnly = { disabled: ['claude-tmux', 'pi-rpc', 'dsh-exec'] };
  assert.equal(resolveRuntime({ runtime: 'claude-tmux' }, null, codexOnly).runtime, 'claude-tmux');
  assert.equal(
    resolveRuntime({ runtime: 'pi-rpc', runtimeMode: 'ops' }, null, codexOnly).runtimeMode,
    'ops',
  );
});

test('a substituted default inherits nothing from the agent it replaced', () => {
  // The agent's provider/model describe pi; the machine only runs claude here.
  const out = resolveRuntime(
    null,
    { runtime: 'pi-rpc', runtimeProvider: 'openrouter', runtimeModel: 'deepseek/x', runtimeMode: 'ops' },
    { disabled: ['pi-rpc', 'codex-exec', 'dsh-exec'] },
  );
  assert.deepEqual(out, {
    runtime: 'claude-tmux', runtimeProvider: null, runtimeModel: null, runtimeMode: null,
  });
});

test('substituting TO pi lands on the default mode, not the agent’s', () => {
  const out = resolveRuntime(
    null,
    { runtime: 'claude-tmux', runtimeMode: 'ops' },
    { disabled: ['claude-tmux', 'codex-exec', 'dsh-exec'] },
  );
  assert.equal(out.runtime, 'pi-rpc');
  assert.equal(out.runtimeMode, 'omp');
});

test('a machine that runs only dsh defaults to dsh, and dsh carries no mode', () => {
  const out = resolveRuntime(null, null, { disabled: ['claude-tmux', 'pi-rpc', 'codex-exec'] });
  assert.deepEqual(out, {
    runtime: 'dsh-exec', runtimeProvider: null, runtimeModel: null, runtimeMode: null,
  });
});

// An agent that defaulted to the removed triage card still holds
// {runtime: 'pi-rpc', runtimeMode: 'triage'}. It must resolve to a pi session —
// the gateway's resolveMode falls back from the unknown mode name on its own.
test('a stale triage default still resolves to pi', () => {
  const out = resolveRuntime(null, { runtime: 'pi-rpc', runtimeMode: 'triage' });
  assert.equal(out.runtime, 'pi-rpc');
  assert.equal(out.runtimeMode, 'triage');
});

test('switching TO pi from a claude agent does not inherit a stale mode', () => {
  // Agent is claude with a leftover mode column; the session picks pi. The
  // levels disagree on backend, so the agent's mode is not inheritable and the
  // session falls to the default rather than silently landing in 'ops'.
  const out = resolveRuntime({ runtime: 'pi-rpc' }, { runtime: 'claude-tmux', runtimeMode: 'ops' });
  assert.equal(out.runtimeMode, 'omp');
});
