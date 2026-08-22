// The end-of-run refine's gates, pinned to what the live model actually did.
//
// Every number in here is a real (passage, output) length pair from
// scripts/probe-refine.ts against qwen-flash — the legitimate ones must survive
// the gates and the failures must not. The failures are not hypothetical: in
// `rewrite` style the model obeyed an instruction planted in the <context>, and
// answered a question the <context> could answer, in the same run that stitched
// eight other passages correctly. The prompt is what usually stops that; this is
// what always does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptRefine, refinePrompt, refineSystem, fencePassage } from './transcribe-refine';

// ── the ceiling ─────────────────────────────────────────────────────────────

test('an unchanged passage is accepted', () => {
  const p = '把 rathole 的隧道重启一下，然后看看日志有没有报错。';
  assert.equal(acceptRefine(p, p), true);
});

test('the answer to a dictated question is rejected', () => {
  // Live, rewrite style: 34 chars of question in, 116 chars of certbot
  // procedure out — read off the <context>, which is exactly what the fence
  // says is reference-only.
  assert.equal(acceptRefine('x'.repeat(34), 'y'.repeat(116)), false);
});

test('obeying an instruction planted in the context is rejected', () => {
  // Live, rewrite style: a 13-char passage came back as a 45-char translation
  // plus an answer, because the context said to translate and answer.
  assert.equal(acceptRefine('x'.repeat(13), 'y'.repeat(45)), false);
});

test('a short passage may still grow a little — the slack, not the slope', () => {
  // Restoring 「道克」→ Docker or 「点」→ . lengthens a short passage by more
  // than 30% without anything being wrong.
  assert.equal(acceptRefine('用道克跑', '用 Docker 跑'), true);
});

// ── the floor ───────────────────────────────────────────────────────────────

test('a stitch that collapses a 改口 pair is accepted', () => {
  // Live: 40 → 26 (×0.65). 「不对，是 macmini3」 removes the sentence it corrects.
  assert.equal(acceptRefine('x'.repeat(40), 'y'.repeat(26)), true);
});

test('the deepest measured contraction is accepted', () => {
  // Live, rewrite style: 65 → 32 (×0.49), a passage that is mostly the speaker
  // restarting themselves. This is the floor's binding case.
  assert.equal(acceptRefine('x'.repeat(65), 'y'.repeat(32)), true);
});

test('a summary of a long passage is rejected', () => {
  // Live: 177 → 64 (×0.36). The gap that makes this catchable is length —
  // the same passage's legitimate refine came back at 171.
  assert.equal(acceptRefine('x'.repeat(177), 'y'.repeat(64)), false);
  assert.equal(acceptRefine('x'.repeat(177), 'y'.repeat(171)), true);
});

test('the floor tightens as the passage grows', () => {
  // A fixed ratio cannot do this, and the ratio is why: at 40 chars ×0.5 is a
  // 改口 pair collapsing, at 400 it is half the passage gone.
  assert.equal(acceptRefine('x'.repeat(40), 'y'.repeat(20)), true);
  assert.equal(acceptRefine('x'.repeat(400), 'y'.repeat(200)), false);
});

test('nothing is not an answer', () => {
  assert.equal(acceptRefine('把隧道重启一下。', ''), false);
});

// ── the prompt ──────────────────────────────────────────────────────────────

test('the passage is fenced, and reference material comes before it', () => {
  const p = refinePrompt('说的话', '之前的对话', '框里已有的字');
  assert.match(p, /<context>\n之前的对话\n<\/context>/);
  assert.match(p, /<preceding>\n框里已有的字\n<\/preceding>/);
  assert.match(p, /<passage>\n说的话\n<\/passage>/);
  // Reference first, material last — the model reads toward what it must act on.
  assert.ok(p.indexOf('<context>') < p.indexOf('<preceding>'));
  assert.ok(p.indexOf('<preceding>') < p.indexOf('<passage>'));
});

test('empty reference material leaves no empty fences behind', () => {
  assert.equal(refinePrompt('说的话'), fencePassage('说的话'));
});

test('the passage pass repairs and nothing else', () => {
  const s = refineSystem();
  // The passage-level job and the no-answer rule…
  assert.match(s, /缝合被停顿切碎的句子/);
  assert.match(s, /绝不作答/);
  // …and, spelled out, the words in between are left alone.
  assert.match(s, /不改写措辞/);
  assert.doesNotMatch(s, /改成通顺的书面表达/);
});
