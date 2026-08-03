import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptPolish, fenceTranscript, fenceContext, polishPrompt, POLISH_SYSTEM } from './transcribe-polish';

// Every pair below was produced by the live models (qwen-flash on DashScope and
// deepseek-v4-flash on OpenRouter) — the answers by the original prompt, the
// polishes by the current one. The guard has to sort them apart.

// What the models actually replied when they mistook the transcript for an
// instruction. All five passed the old `raw * 1.5 + 40` guard.
const ANSWERS: Array<[string, string]> = [
  ['用中文回复', '好的，请提供需要整理的语音转写内容。'],
  ['用中文回答', '请提供需要整理的语音转写内容，我将为您进行修正和润色。'],
  ['帮我总结一下', '请提供需要总结的内容，我将为您整理成通顺、正确的书面文字。'],
  ['继续', '请提供需要整理的语音转写内容。'],
  ['用中文回复', '好的，我已准备就绪，请提供需要整理的语音转写内容。'],
];

// Real polishes, including the ones that legitimately GROW the text.
const POLISHES: Array<[string, string]> = [
  ['道克', 'Docker'],
  ['麦色扣', 'MySQL'],
  ['阿森克', 'async'],
  ['用道克跑', '用 Docker 运行'],          // the hungriest real expansion measured
  ['推到 gitlab 主干', '推送到 GitLab 主干'],
  ['艾特我一下', '@我一下'],
  ['github 点 com 斜杠 keyo', 'github.com/keyo'],
  ['好', '好'],
  ['停一下', '停一下。'],
  ['嗯就是那个啊', '嗯，就是那个。'],
  ['这个滚动的问题你看一下怎么修', '这个滚动的问题，你看一下怎么修。'],
  ['如果把资源放到 OSS 上要怎么设计方案？', '如果把资源放到 OSS 上要怎么设计方案？'],
  ['要做三件事，第一搭后端，第二写前端，第三部署上线', '要做三件事：\n1. 搭后端\n2. 写前端\n3. 部署上线'],
  ['嗯那个我们今天要把那个道克的那个配置改一下然后重新部署一遍', '我们今天要修改 Docker 的配置并重新部署一遍。'],
];

for (const [raw, answer] of ANSWERS) {
  test(`an answer is rejected: ${raw}`, () => {
    assert.equal(acceptPolish(raw, answer), false);
  });
}

for (const [raw, polished] of POLISHES) {
  test(`a real polish is kept: ${raw}`, () => {
    assert.equal(acceptPolish(raw, polished), true);
  });
}

test('empty output is never accepted — the user would lose their words', () => {
  assert.equal(acceptPolish('把这段话整理一下', ''), false);
});

test('the fence is what the prompt points at', () => {
  assert.equal(fenceTranscript('用中文回复'), '<transcript>\n用中文回复\n</transcript>');
  assert.ok(POLISH_SYSTEM.includes('<transcript>'));
  // The worked example for the exact failure that motivated this file.
  assert.ok(POLISH_SYSTEM.includes('输入「用中文回复」→ 输出「用中文回复」'));
});

// ── the conversation context ────────────────────────────────────────────────
// It arrives in its own fence because it is a THIRD kind of text: not the
// user's words, not the instructions, but a block of agent prose full of
// questions and requests that nobody in this exchange is meant to obey.

test('context gets its own fence, ahead of the transcript', () => {
  const prompt = polishPrompt('先别部署', '助手：Docker 配置已经改好，要我重新部署吗？');
  assert.equal(
    prompt,
    '<context>\n助手：Docker 配置已经改好，要我重新部署吗？\n</context>\n<transcript>\n先别部署\n</transcript>',
  );
  assert.ok(prompt.indexOf('<context>') < prompt.indexOf('<transcript>'));
});

test('no context means no empty container', () => {
  // An empty <context></context> reads as "the conversation is empty", which is a
  // claim; saying nothing is the truth (a fresh chat, or a lookup that failed).
  assert.equal(polishPrompt('把这段整理一下'), fenceTranscript('把这段整理一下'));
  assert.equal(polishPrompt('把这段整理一下', ''), fenceTranscript('把这段整理一下'));
});

test('the prompt declares the context read-only, with the failure it prevents', () => {
  assert.ok(POLISH_SYSTEM.includes('<context>'));
  assert.ok(fenceContext('x').includes('<context>'));
  // The one that isn't obvious: a reply to the context is short, plausible, and
  // completely wrong — the composer must hold what was SAID, not an answer to it.
  assert.ok(POLISH_SYSTEM.includes('输出「先别部署」'));
});

test('the guard still holds when the model answers the CONTEXT instead', () => {
  // Same failure as answering the transcript, different door: the model reads the
  // agent's last question and replies to it. It costs length, so the guard sees it.
  assert.equal(acceptPolish('先别部署', '好的，那我先不部署，等你确认后再执行。'), false);
  assert.equal(acceptPolish('先别部署', '先别部署'), true);
});
