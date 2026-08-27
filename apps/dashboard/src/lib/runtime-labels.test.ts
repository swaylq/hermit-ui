import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_KINDS, CUSTOM_HARNESSES, RUNTIME_BLURB, RUNTIME_NEEDS,
  runtimeLabel, runtimeShortLabel, sharesConversation, runtimeDetail, isCustomHarness, hasTmuxPane,
  providerMark,
} from './runtime-labels';

test('every harness has a label, a blurb and an install note', () => {
  for (const k of RUNTIME_KINDS) {
    assert.ok(runtimeLabel(k).length > 0, `${k} needs a label`);
    assert.ok(runtimeShortLabel(k).length > 0, `${k} needs a short label`);
    assert.ok(RUNTIME_BLURB[k]?.length > 0, `${k} needs a blurb`);
    assert.ok(RUNTIME_NEEDS[k]?.length > 0, `${k} needs an install note`);
  }
});

// A harness is composable when it can be POINTED somewhere. claude-sdk can:
// Claude Code reads ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN from its
// environment. kimi-code can too, through KIMI_MODEL_BASE_URL /
// KIMI_MODEL_API_KEY. The pane cannot (it takes both from the machine's
// settings.json), and codex authenticates through `codex login` with no
// endpoint to name at all.
test('every harness that can be pointed at an endpoint is composable', () => {
  assert.deepEqual([...CUSTOM_HARNESSES], ['claude-sdk', 'pi-rpc', 'prime-rpc', 'dsh-exec', 'kimi-code']);
  assert.equal(isCustomHarness('claude-tmux'), false);
  assert.equal(isCustomHarness('codex-exec'), false);
  assert.equal(isCustomHarness('prime-rpc'), true);
  assert.equal(isCustomHarness('kimi-code'), true);
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
  // The SDK driver names its endpoint too, now that it can be pointed at one —
  // this string is the tooltip behind the header's shortened vendor mark.
  assert.equal(
    runtimeDetail('claude-sdk', 'kimi-coding', 'k3[1m]'),
    'Claude Code (Agent SDK) · kimi-coding · k3[1m]',
  );
  // …and the built-in has no credential, so no provider, and reads as before.
  assert.equal(runtimeDetail('claude-sdk', null, 'opus'), 'Claude Code (Agent SDK) · opus');
  // Moonshot's own agent, which the header renders the same way — the mark
  // says Kimi either way, and this tooltip says which agent is running it.
  assert.equal(runtimeDetail('kimi-code', 'kimi-coding', 'k3'), 'Kimi Code CLI · kimi-coding · k3');
});

// ── whose model answers ────────────────────────────────────────────

// The header chip that carries this reads "Claude" for a Kimi session and for a
// subscription one alike, because the harness is the same Claude Code. The mark
// is the only thing on the row that tells them apart.
test('both ways of reaching Kimi are marked Kimi', () => {
  // Kimi Code (the membership endpoint) and the Moonshot open platform are two
  // key namespaces and two model-id namespaces — one vendor on the header.
  assert.equal(providerMark('kimi-coding'), 'Kimi');
  assert.equal(providerMark('moonshotai-cn'), 'Kimi');
  assert.equal(providerMark('zai'), 'GLM');
});

// `provider` is free text the user typed into Settings → Models, so the table
// can only ever be a spelling aid. An entry it has not met is shown as typed:
// ugly beats blank, and blank is what the header had before.
test('an unknown provider is shown as typed, not dropped', () => {
  assert.equal(providerMark('hyqubit'), 'hyqubit');
  assert.equal(providerMark('  KIMI-CODING '), 'Kimi');
  assert.equal(providerMark('my-litellm'), 'my-litellm');
});

// The column takes 64 characters and the chip lives in a row that runs out of
// width at 390px. Cut here, not in CSS: `truncate` needs a block box and the
// row around this is inline.
test('a long provider is cut to something a phone header can hold', () => {
  assert.equal(providerMark('a-very-long-provider-name'), 'a-very-long…');
  assert.equal(providerMark('exactly12chr'), 'exactly12chr');
});

// A built-in backend has no credential and therefore no provider. Null is the
// signal the header uses to render nothing at all.
test('no provider means no mark', () => {
  assert.equal(providerMark(null), null);
  assert.equal(providerMark(undefined), null);
  assert.equal(providerMark('   '), null);
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
  assert.equal(hasTmuxPane('kimi-code'), false);
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

// Both drivers are Claude Code, and both must say so — the header chip, the
// picker and the session sheet all read these. They must also be tellable
// apart, or a user cannot see which one a session is on.
test('both claude harnesses are labelled as Claude Code, distinguishably', () => {
  assert.equal(runtimeLabel('claude-sdk'), 'Claude Code');
  assert.equal(runtimeLabel('claude-tmux'), 'Claude Code (tmux)');
  assert.equal(runtimeShortLabel('claude-sdk'), 'Claude');
  assert.equal(runtimeShortLabel('claude-tmux'), 'Claude');
  assert.notEqual(runtimeLabel('claude-sdk'), runtimeLabel('claude-tmux'));
});

// The pane takes its endpoint, its key and its model from the machine's
// ~/.claude/settings.json and ignores anything the gateway sets, so offering
// "Claude Code (tmux) + Kimi" would offer something that does not exist. The
// SDK driver reads all three from its environment, which is the whole
// difference.
test('only the SDK claude driver is user-composable', () => {
  assert.equal(isCustomHarness('claude-sdk'), true);
  assert.equal(isCustomHarness('claude-tmux'), false);
});

test('the SDK driver has no pane to attach a terminal to', () => {
  assert.equal(hasTmuxPane('claude-sdk'), false);
  assert.equal(hasTmuxPane('claude-tmux'), true);
});

// The switch dialog warns "the running context is not kept" and the resolver
// drops the external session id — both gated on this one predicate, so they can
// never disagree about whether a move is lossless.
const side = (runtime: string | null, credentialId: string | null = null) => ({ runtime, credentialId });

test('only the two claude drivers share a conversation', () => {
  assert.equal(sharesConversation(side('claude-tmux'), side('claude-sdk')), true);
  assert.equal(sharesConversation(side('claude-sdk'), side('claude-tmux')), true);
  // Same harness on both sides is trivially the same conversation.
  assert.equal(sharesConversation(side('claude-sdk'), side('claude-sdk')), true);
});

test('every other pair drops the conversation', () => {
  for (const other of ['pi-rpc', 'prime-rpc', 'codex-exec', 'dsh-exec']) {
    for (const claude of ['claude-sdk', 'claude-tmux']) {
      assert.equal(sharesConversation(side(claude), side(other)), false, `${claude} → ${other}`);
      assert.equal(sharesConversation(side(other), side(claude)), false, `${other} → ${claude}`);
    }
  }
  assert.equal(sharesConversation(side('pi-rpc'), side('prime-rpc')), false);
});

test('an absent or unknown harness never claims to keep context', () => {
  assert.equal(sharesConversation(side(null), side('claude-sdk')), false);
  assert.equal(sharesConversation(side('claude-sdk'), undefined), false);
  assert.equal(sharesConversation(side('claude-sdk'), side('something-new')), false);
});

// Since claude-sdk became composable, "same driver" stopped being the whole
// answer. Two claude-sdk backends on different endpoints write the same
// <uuid>.jsonl and cannot read each other's history: the transcript carries
// provider-signed thinking blocks, so replaying Anthropic's at Kimi is rejected
// at the first request — every later message of a session that looked fine when
// it was switched.
test('two claude drivers on different credentials do NOT share a conversation', () => {
  assert.equal(sharesConversation(side('claude-sdk', null), side('claude-sdk', 'kimi-code')), false);
  assert.equal(sharesConversation(side('claude-sdk', 'kimi-code'), side('claude-sdk', null)), false);
  assert.equal(sharesConversation(side('claude-sdk', 'kimi-code'), side('claude-sdk', 'glm')), false);
  // The pane is subscription-only, so moving to a composed SDK backend is a
  // different endpoint too — and the transcript does not travel.
  assert.equal(sharesConversation(side('claude-tmux', null), side('claude-sdk', 'kimi-code')), false);
});

test('two claude drivers on the SAME credential still share it', () => {
  assert.equal(sharesConversation(side('claude-sdk', 'kimi-code'), side('claude-sdk', 'kimi-code')), true);
});
