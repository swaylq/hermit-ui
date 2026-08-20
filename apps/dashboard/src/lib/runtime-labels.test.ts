import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_KINDS, CUSTOM_HARNESSES, RUNTIME_BLURB, RUNTIME_NEEDS,
  runtimeLabel, runtimeShortLabel, runtimeDetail, isCustomHarness, hasTmuxPane,
} from './runtime-labels';

test('every harness has a label, a blurb and an install note', () => {
  for (const k of RUNTIME_KINDS) {
    assert.ok(runtimeLabel(k).length > 0, `${k} needs a label`);
    assert.ok(runtimeShortLabel(k).length > 0, `${k} needs a short label`);
    assert.ok(RUNTIME_BLURB[k]?.length > 0, `${k} needs a blurb`);
    assert.ok(RUNTIME_NEEDS[k]?.length > 0, `${k} needs an install note`);
  }
});

// The two subscription harnesses are the ones a user cannot compose a backend
// out of — there is only ever one credential for each, and it is not ours.
test('only the non-subscription harnesses are composable', () => {
  assert.deepEqual([...CUSTOM_HARNESSES], ['pi-rpc', 'prime-rpc', 'dsh-exec']);
  assert.equal(isCustomHarness('claude-tmux'), false);
  assert.equal(isCustomHarness('codex-exec'), false);
  assert.equal(isCustomHarness('prime-rpc'), true);
});

// It reads straight off a JSON column, so it has to survive a non-string.
test('isCustomHarness tolerates whatever the JSON column held', () => {
  assert.equal(isCustomHarness(null), false);
  assert.equal(isCustomHarness(undefined), false);
  assert.equal(isCustomHarness(42), false);
  assert.equal(isCustomHarness({}), false);
});

test('detail names the endpoint for the harnesses that have one', () => {
  assert.equal(runtimeDetail('pi-rpc', 'hyqubit', 'claude-opus-5'), 'pi · hyqubit · claude-opus-5');
  assert.equal(runtimeDetail('prime-rpc', 'kimi', 'kimi-k3'), 'Prime Agent · kimi · kimi-k3');
  // codex authenticates as itself; naming a provider would be a field the user
  // cannot set and the harness does not read.
  assert.equal(runtimeDetail('codex-exec', 'hyqubit', 'gpt-5.1'), 'Codex · gpt-5.1');
  assert.equal(runtimeDetail('claude-tmux', 'hyqubit', 'x'), 'Claude Code (interactive, tmux pane)');
});

// ── which harnesses have a pane to attach to ────────────────────────────────

// codex and dsh are one subprocess per turn — no pane, exactly like pi. codex
// was missed when the terminal link was written against pi alone, so the button
// was there and attached to nothing.
test('only the tmux harness has a pane', () => {
  assert.equal(hasTmuxPane('claude-tmux'), true);
  assert.equal(hasTmuxPane('pi-rpc'), false);
  assert.equal(hasTmuxPane('prime-rpc'), false);
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

// Every stored kind is either paneless or the tmux one — a new harness that is
// neither would slip through this predicate unnoticed.
test('every harness is accounted for', () => {
  assert.equal(RUNTIME_KINDS.filter((k) => hasTmuxPane(k)).length, 1);
});
