import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN_BACKENDS, listBackends, availableBackends, backendById, backendsConfigOf,
  effectiveDefaultBackendId, isBackendEnabled, toggleBackend, uniqueBackendId,
  addBackendInstance, removeBackendInstance, updateBackendInstance, legacyHarnessOf,
  type BackendsConfig,
} from './backends';

const PI: BackendsConfig = {
  disabled: [],
  instances: [
    { id: 'pi-hyqubit', harness: 'pi-rpc', credentialId: 'hyqubit', label: 'pi · hyqubit' },
    { id: 'prime-kimi', harness: 'prime-rpc', credentialId: 'kimi', label: 'prime · Kimi' },
  ],
};

// The resting state of a machine nobody has configured: two subscription
// backends, both on. Not "everything this build knows about" — pi and prime
// cannot start without a credential, so offering them would be a lie.
test('an unconfigured machine offers exactly the two built-ins', () => {
  assert.deepEqual(listBackends(null).map((b) => b.id), ['claude-tmux', 'codex-exec']);
  assert.deepEqual(availableBackends(null).map((b) => b.id), ['claude-tmux', 'codex-exec']);
  assert.equal(BUILT_IN_BACKENDS.every((b) => b.builtIn && b.credentialId === null), true);
});

test('composed backends join the list after the built-ins', () => {
  assert.deepEqual(
    listBackends(PI).map((b) => b.id),
    ['claude-tmux', 'codex-exec', 'pi-hyqubit', 'prime-kimi'],
  );
});

// ── legacy values ───────────────────────────────────────────────────────────

// Every Agent and ChatSession row written before backends became instances
// holds a bare harness name. They have to keep resolving, or the whole fleet
// silently moves to claude on the next turn.
test('a stored bare harness resolves onto an instance of that harness', () => {
  assert.equal(backendById(PI, 'pi-rpc')?.id, 'pi-hyqubit');
  assert.equal(backendById(PI, 'prime-rpc')?.id, 'prime-kimi');
  // The retired third backend, folded back into pi as an engine chosen by mode.
  assert.equal(backendById(PI, 'omp-rpc')?.id, 'pi-hyqubit');
});

test('a bare harness with no instance resolves to nothing, not to the wrong one', () => {
  assert.equal(backendById(PI, 'dsh-exec'), null);
  assert.equal(backendById(null, 'pi-rpc'), null);
});

test('legacyHarnessOf only reads harness names', () => {
  assert.equal(legacyHarnessOf('pi-rpc'), 'pi-rpc');
  assert.equal(legacyHarnessOf('omp-rpc'), 'pi-rpc');
  assert.equal(legacyHarnessOf('claude-tmux'), null); // a built-in, not a legacy value
  assert.equal(legacyHarnessOf('pi-hyqubit'), null);  // an instance id
  assert.equal(legacyHarnessOf(null), null);
});

// ── availability ────────────────────────────────────────────────────────────

test('a disabled backend is hidden, unless it is the one in hand', () => {
  const off = toggleBackend(PI, 'pi-hyqubit', false)!;
  assert.equal(availableBackends(off).some((b) => b.id === 'pi-hyqubit'), false);
  // The picker has to be able to represent the state the session is IN.
  assert.equal(availableBackends(off, 'pi-hyqubit').some((b) => b.id === 'pi-hyqubit'), true);
});

// It looks like a gap in "never misrepresent what is running" and is not: the
// resolver has already moved such a session to the floor, so claude-tmux is
// what its next message really starts on.
test('a DELETED backend gets no card', () => {
  const gone = removeBackendInstance(PI, 'pi-hyqubit');
  assert.equal(availableBackends(gone, 'pi-hyqubit').some((b) => b.id === 'pi-hyqubit'), false);
  assert.equal(availableBackends(gone, 'pi-rpc').some((b) => b.id === 'pi-rpc'), false);
});

test('the picker is never empty, whatever is switched off', () => {
  let cfg: BackendsConfig | null = PI;
  for (const id of ['claude-tmux', 'codex-exec', 'pi-hyqubit', 'prime-kimi']) {
    const next = toggleBackend(cfg, id, false);
    if (next) cfg = next;
  }
  // The last toggle is refused rather than applied.
  assert.ok(availableBackends(cfg).length >= 1);
});

test('disabling everything is refused', () => {
  let cfg: BackendsConfig | null = { disabled: [], instances: [] };
  cfg = toggleBackend(cfg, 'claude-tmux', false)!;
  assert.equal(toggleBackend(cfg, 'codex-exec', false), null);
});

// ── the effective default ───────────────────────────────────────────────────

test('a default the machine cannot run falls through to one it can', () => {
  const off = toggleBackend(PI, 'pi-hyqubit', false)!;
  assert.equal(effectiveDefaultBackendId('pi-hyqubit', off), 'claude-tmux');
  assert.equal(effectiveDefaultBackendId('prime-kimi', PI), 'prime-kimi');
  // A legacy bare harness resolves through to the instance, not to the floor.
  assert.equal(effectiveDefaultBackendId('pi-rpc', PI), 'pi-hyqubit');
  assert.equal(effectiveDefaultBackendId(null, PI), 'claude-tmux');
});

// ── mutation helpers ────────────────────────────────────────────────────────

test('ids are unique against built-ins and existing instances alike', () => {
  assert.equal(uniqueBackendId('pi-rpc', 'hyqubit', PI), 'pi-hyqubit-2');
  assert.equal(uniqueBackendId('dsh-exec', 'deepseek', PI), 'dsh-deepseek');
});

test('adding and updating leaves the rest of the config alone', () => {
  const added = addBackendInstance(PI, {
    id: 'pi-kimi', harness: 'pi-rpc', credentialId: 'kimi', label: 'pi · Kimi',
  });
  assert.equal(added.instances?.length, 3);
  const renamed = updateBackendInstance(added, 'pi-kimi', { label: 'cheap pi' });
  assert.equal(renamed.instances?.find((i) => i.id === 'pi-kimi')?.label, 'cheap pi');
  assert.equal(renamed.instances?.find((i) => i.id === 'pi-hyqubit')?.label, 'pi · hyqubit');
});

// Otherwise re-adding a backend with the same id comes back switched off, which
// reads as the delete having failed.
test('removing an instance takes its disabled entry with it', () => {
  const off = toggleBackend(PI, 'pi-hyqubit', false)!;
  const gone = removeBackendInstance(off, 'pi-hyqubit');
  assert.equal(gone.disabled.includes('pi-hyqubit'), false);
  const back = addBackendInstance(gone, {
    id: 'pi-hyqubit', harness: 'pi-rpc', credentialId: 'hyqubit', label: 'pi · hyqubit',
  });
  assert.equal(isBackendEnabled('pi-hyqubit', back), true);
});

// ── reading the column ──────────────────────────────────────────────────────

test('an unreadable instance is dropped, not fatal', () => {
  const cfg = backendsConfigOf({
    backendsConfig: {
      disabled: ['codex-exec', 7],
      instances: [
        { id: 'ok', harness: 'pi-rpc', credentialId: 'hyqubit', label: 'ok' },
        { id: 'no-harness', credentialId: 'hyqubit' },
        { id: 'claude-tmux', harness: 'pi-rpc', credentialId: 'x' }, // shadows a built-in
        'nonsense',
      ],
    },
  });
  assert.deepEqual(cfg?.disabled, ['codex-exec']);
  assert.deepEqual(cfg?.instances?.map((i) => i.id), ['ok']);
});

test('a missing or malformed column reads as unconfigured', () => {
  assert.equal(backendsConfigOf(null), null);
  assert.equal(backendsConfigOf({ backendsConfig: 'nope' }), null);
  assert.deepEqual(backendsConfigOf({ backendsConfig: {} })?.disabled, []);
});
