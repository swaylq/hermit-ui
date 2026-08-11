import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableBackends, isBackendEnabled, toggleBackend, ALL_ENABLED,
} from './backend-availability';
import { BACKEND_OPTIONS } from './runtime-labels';

// An unconfigured machine is every machine that existed before this feature, so
// "absent" has to mean the behaviour they already had.
test('a machine with no config offers everything', () => {
  assert.deepEqual(availableBackends(null), [...BACKEND_OPTIONS]);
  assert.deepEqual(availableBackends(undefined), [...BACKEND_OPTIONS]);
  assert.deepEqual(availableBackends(ALL_ENABLED), [...BACKEND_OPTIONS]);
  assert.equal(isBackendEnabled('codex-exec', null), true);
});

test('a disabled backend drops out of the picker', () => {
  const cfg = { disabled: ['codex-exec'] };
  assert.equal(isBackendEnabled('codex-exec', cfg), false);
  assert.equal(availableBackends(cfg).includes('codex-exec'), false);
  assert.equal(availableBackends(cfg).includes('claude-tmux'), true);
});

// The picker has to be able to represent the state the session is IN. Hiding
// the current option would redraw the selection as something else — the sheet
// would show "Claude Code" selected on a codex session.
test('the backend a session is already on stays visible even when disabled', () => {
  const cfg = { disabled: ['codex-exec'] };
  assert.equal(availableBackends(cfg, 'codex-exec').includes('codex-exec'), true);
  // ...and only for that one.
  assert.equal(availableBackends({ disabled: ['pi-rpc', 'codex-exec'] }, 'codex-exec').includes('pi-rpc'), false);
});

// A picker with nothing in it is a dead end with no way back.
test('everything disabled still yields a usable picker', () => {
  const cfg = { disabled: [...BACKEND_OPTIONS] };
  assert.deepEqual(availableBackends(cfg), ['claude-tmux']);
  assert.deepEqual(availableBackends(cfg, 'pi-rpc'), ['pi-rpc']);
});

test('toggling off records it and toggling back on clears it', () => {
  const off = toggleBackend(null, 'codex-exec', false);
  assert.deepEqual(off, { disabled: ['codex-exec'] });
  assert.deepEqual(toggleBackend(off, 'codex-exec', true), { disabled: [] });
});

test('the stored order follows BACKEND_OPTIONS, so equivalent sets do not churn', () => {
  const a = toggleBackend(toggleBackend(null, 'triage', false), 'pi-rpc', false);
  const b = toggleBackend(toggleBackend(null, 'pi-rpc', false), 'triage', false);
  assert.deepEqual(a, b);
});

// Refused rather than silently ignored, so the UI can explain itself.
test('disabling the last backend is refused', () => {
  let cfg = toggleBackend(null, 'codex-exec', false)!;
  cfg = toggleBackend(cfg, 'triage', false)!;
  cfg = toggleBackend(cfg, 'pi-rpc', false)!;
  assert.notEqual(cfg, null);
  assert.equal(toggleBackend(cfg, 'claude-tmux', false), null);
});

test('an unknown value in the stored set is harmless', () => {
  const cfg = { disabled: ['omp-rpc-retired', 'codex-exec'] };
  assert.equal(availableBackends(cfg).includes('codex-exec'), false);
  assert.equal(availableBackends(cfg).length, BACKEND_OPTIONS.length - 1);
});
