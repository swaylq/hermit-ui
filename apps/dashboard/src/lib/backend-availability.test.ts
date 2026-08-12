import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableBackends, isBackendEnabled, toggleBackend, ALL_ENABLED,
  effectiveDefaultBackend, backendsConfigOf,
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

// ── the effective default ───────────────────────────────────────────────────

test('a default the machine offers is left alone', () => {
  assert.equal(effectiveDefaultBackend('claude-tmux', null), 'claude-tmux');
  assert.equal(effectiveDefaultBackend('codex-exec', { disabled: ['pi-rpc'] }), 'codex-exec');
});

// The reported case: a machine with Claude Code off and codex on used to draw
// "Claude Code · default · off" as the selected card, and New chat opened on it.
test('a machine that runs only codex defaults to codex', () => {
  const cfg = { disabled: ['claude-tmux', 'pi-rpc', 'triage'] };
  assert.equal(effectiveDefaultBackend('claude-tmux', cfg), 'codex-exec');
  // Including for an agent that explicitly pinned the switched-off backend.
  assert.equal(effectiveDefaultBackend('pi-rpc', cfg), 'codex-exec');
});

// BACKEND_OPTIONS order, i.e. the leftmost card the picker draws — there is no
// other signal for "which of the ones that work", and an arbitrary-but-stable
// answer beats one that changes with the shape of the stored set.
test('with several left, the substitute is the first the picker would show', () => {
  assert.equal(effectiveDefaultBackend('claude-tmux', { disabled: ['claude-tmux'] }), 'pi-rpc');
  assert.equal(
    effectiveDefaultBackend('claude-tmux', { disabled: ['claude-tmux', 'pi-rpc'] }),
    'codex-exec',
  );
});

// Same floor as the picker's: a machine with everything off still has to name
// something, and claude-tmux is the one backend that needs no per-machine setup.
test('everything off falls back to the same floor the picker uses', () => {
  const cfg = { disabled: [...BACKEND_OPTIONS] };
  assert.equal(effectiveDefaultBackend('codex-exec', cfg), 'claude-tmux');
});

test('triage is substituted for, and substituted to, as a whole card', () => {
  assert.equal(effectiveDefaultBackend('triage', { disabled: ['triage'] }), 'claude-tmux');
  assert.equal(
    effectiveDefaultBackend('claude-tmux', { disabled: ['claude-tmux', 'pi-rpc', 'codex-exec'] }),
    'triage',
  );
});

// ── reading the Machine row ─────────────────────────────────────────────────

test('a machine row with no config reads as nothing configured', () => {
  assert.equal(backendsConfigOf(null), null);
  assert.equal(backendsConfigOf({}), null);
  assert.equal(backendsConfigOf({ backendsConfig: null }), null);
});

test('a stored config is read back as itself', () => {
  assert.deepEqual(backendsConfigOf({ backendsConfig: { disabled: ['codex-exec'] } }), {
    disabled: ['codex-exec'],
  });
});

// Nothing validates what an older release wrote into the JSON column, so a shape
// this build cannot read has to mean "everything enabled" rather than throw on
// the gateway's 2s poll.
test('a config of the wrong shape reads as nothing configured', () => {
  assert.equal(backendsConfigOf({ backendsConfig: 'codex-exec' }), null);
  assert.equal(backendsConfigOf({ backendsConfig: ['codex-exec'] }), null);
  assert.equal(backendsConfigOf({ backendsConfig: { disabled: 'codex-exec' } }), null);
  assert.deepEqual(backendsConfigOf({ backendsConfig: { disabled: [1, 'pi-rpc'] } }), {
    disabled: ['pi-rpc'],
  });
});
