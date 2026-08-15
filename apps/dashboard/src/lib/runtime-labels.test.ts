import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_OPTIONS, BACKEND_BLURB, RUNTIME_KINDS,
  backendLabel, toBackendOption, fromBackendOption, hasTmuxPane,
} from './runtime-labels';

test('every backend option has a label and a blurb', () => {
  for (const o of BACKEND_OPTIONS) {
    assert.ok(backendLabel(o).length > 0, `${o} needs a label`);
    assert.ok(BACKEND_BLURB[o]?.length > 0, `${o} needs a blurb`);
  }
});

test('every stored kind gets a card, and every card stores a kind', () => {
  for (const k of RUNTIME_KINDS) {
    assert.equal(toBackendOption(k, null), k);
    assert.deepEqual(fromBackendOption(k), { runtime: k, runtimeMode: null });
  }
});

test('a pi session is the pi card whatever its mode', () => {
  // Including 'triage', which sessions created before the triage card was
  // removed (2026-08-15) still hold in runtimeMode. They must light the pi
  // card, not fall through to claude.
  for (const m of [null, 'omp', 'scout', 'writer', 'triage']) {
    assert.equal(toBackendOption('pi-rpc', m), 'pi-rpc');
  }
});

test('an unknown or absent runtime falls back to claude, not to a blank card', () => {
  assert.equal(toBackendOption(null, null), 'claude-tmux');
  assert.equal(toBackendOption('omp-rpc', null), 'claude-tmux');
  // The retired triage card stored runtime 'pi-rpc', never 'triage' — but a
  // value that never existed must still land somewhere real.
  assert.equal(toBackendOption('triage', null), 'claude-tmux');
});

// ── which backends have a pane to attach to ─────────────────────────────────

// codex and dsh are one subprocess per turn — no pane, exactly like pi. codex
// was missed when the terminal link was written against pi alone, so the button
// was there and attached to nothing.
test('only the tmux backend has a pane', () => {
  assert.equal(hasTmuxPane('claude-tmux'), true);
  assert.equal(hasTmuxPane('pi-rpc'), false);
  assert.equal(hasTmuxPane('codex-exec'), false);
  assert.equal(hasTmuxPane('dsh-exec'), false);
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

test('no card carries a mode of its own out of the picker', () => {
  // null means "this card says nothing about the mode" — the caller keeps
  // whatever the Mode select holds.
  assert.deepEqual(fromBackendOption('pi-rpc'), { runtime: 'pi-rpc', runtimeMode: null });
  assert.deepEqual(fromBackendOption('claude-tmux'), { runtime: 'claude-tmux', runtimeMode: null });
  assert.deepEqual(fromBackendOption('dsh-exec'), { runtime: 'dsh-exec', runtimeMode: null });
});
