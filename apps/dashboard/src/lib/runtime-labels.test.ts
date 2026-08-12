import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_OPTIONS, BACKEND_BLURB, RUNTIME_KINDS, TRIAGE_MODE,
  backendLabel, toBackendOption, fromBackendOption, hasTmuxPane,
} from './runtime-labels';

// The picker's list and the stored backends are different sets, and keeping
// them apart is the whole trick: `triage` is a card, not a backend. If it ever
// leaks into RUNTIME_KINDS, `isRuntimeKind('triage')` starts returning true and
// a session gets written with runtime: 'triage', which no gateway understands.
test('triage is a picker option, never a stored runtime kind', () => {
  assert.ok(BACKEND_OPTIONS.includes(TRIAGE_MODE));
  assert.ok(!(RUNTIME_KINDS as readonly string[]).includes(TRIAGE_MODE));
});

test('every backend option has a label and a blurb', () => {
  for (const o of BACKEND_OPTIONS) {
    assert.ok(backendLabel(o).length > 0, `${o} needs a label`);
    assert.ok(BACKEND_BLURB[o]?.length > 0, `${o} needs a blurb`);
  }
});

test('the triage card round-trips to pi-rpc plus the triage mode', () => {
  assert.deepEqual(fromBackendOption(TRIAGE_MODE), { runtime: 'pi-rpc', runtimeMode: TRIAGE_MODE });
  assert.equal(toBackendOption('pi-rpc', TRIAGE_MODE), TRIAGE_MODE);
});

test('a plain pi session is the pi card whatever its mode', () => {
  for (const m of [null, 'omp', 'scout', 'writer']) {
    assert.equal(toBackendOption('pi-rpc', m), 'pi-rpc');
  }
});

// triage is a PI mode, so the pair only means triage when the backend is pi.
// A claude session carrying a stale runtimeMode must still read as claude —
// resolveRuntime already returns null for a mode on anything that is not pi.
test('the triage mode on a claude session does not light the triage card', () => {
  assert.equal(toBackendOption('claude-tmux', TRIAGE_MODE), 'claude-tmux');
});

test('an unknown or absent runtime falls back to claude, not to a blank card', () => {
  assert.equal(toBackendOption(null, null), 'claude-tmux');
  assert.equal(toBackendOption('omp-rpc', null), 'claude-tmux');
});

// ── which backends have a pane to attach to ─────────────────────────────────

// codex is one `codex exec` per turn — no pane, exactly like pi. It was missed
// when the terminal link was written against pi alone, so the button was there
// and attached to nothing.
test('only the tmux backend has a pane', () => {
  assert.equal(hasTmuxPane('claude-tmux'), true);
  assert.equal(hasTmuxPane('pi-rpc'), false);
  assert.equal(hasTmuxPane('codex-exec'), false);
  assert.equal(hasTmuxPane('omp-rpc'), false);
});

// Absent/unknown is the tmux path in the gateway (runtimeFor returns null for
// anything it does not recognise), so it has to be the pane answer here too.
test('an unknown or absent runtime keeps the pane answer, as the gateway does', () => {
  assert.equal(hasTmuxPane(null), true);
  assert.equal(hasTmuxPane(undefined), true);
  assert.equal(hasTmuxPane('something-else'), true);
});

// Every stored kind is either paneless or the tmux one — a new backend that is
// neither would slip through this predicate unnoticed.
test('every runtime kind is accounted for', () => {
  for (const k of RUNTIME_KINDS) {
    assert.equal(typeof hasTmuxPane(k), 'boolean');
  }
  assert.equal(RUNTIME_KINDS.filter((k) => hasTmuxPane(k)).length, 1);
});

test('the two real backends carry no mode of their own out of the picker', () => {
  // null means "this card says nothing about the mode" — the caller keeps
  // whatever the Mode select holds. Only triage pins one.
  assert.deepEqual(fromBackendOption('pi-rpc'), { runtime: 'pi-rpc', runtimeMode: null });
  assert.deepEqual(fromBackendOption('claude-tmux'), { runtime: 'claude-tmux', runtimeMode: null });
});
