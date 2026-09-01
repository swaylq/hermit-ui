import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptPlainSpeak, plainSpeakMessages, providerRefused } from './plain-speak';

// A reply of the shape this feature exists for: correct, dense, and unreadable
// unless you already know what it is about.
const REPLY =
  '三个入口现在走同一个函数了，重复的调用点还剩 6 处，真实数更大。' +
  '代价是每轮多一次序列化，p95 上多出 8 毫秒。剩下的事情是把旧调用点删掉，等你点头再动。';

test('acceptPlainSpeak: a rewrite of about the same size passes', () => {
  const out =
    '原来有三个地方各写各的，现在都改成调用同一个函数了。' +
    '还剩至少 6 处老的调用点没删，实际可能更多。' +
    '换来的代价是每轮多做一次数据转换，慢了 8 毫秒（按最慢的那 5% 的请求算）。' +
    '删旧调用点这件事要等你同意再做。';
  assert.equal(acceptPlainSpeak(REPLY, out), true);
});

test('acceptPlainSpeak: an ANSWER to the reply is refused', () => {
  // What a model that obeyed the text instead of rewriting it produces — this
  // is the failure the lower bound exists to catch.
  assert.equal(acceptPlainSpeak(REPLY, '好的，我这就把旧的调用点删掉。'), false);
  assert.equal(acceptPlainSpeak(REPLY, 'PWNED'), false);
});

test('acceptPlainSpeak: an essay is refused', () => {
  // The ceiling is 2.5x plus a fixed allowance, so a rewrite is allowed to be
  // noticeably longer than its source — unpacking a term costs a clause. Ten
  // times longer is not a rewrite any more.
  assert.equal(acceptPlainSpeak(REPLY, '这'.repeat(REPLY.length * 10)), false);
});

test('acceptPlainSpeak: empty is refused', () => {
  assert.equal(acceptPlainSpeak(REPLY, ''), false);
  assert.equal(acceptPlainSpeak(REPLY, '   \n '), false);
});

test('acceptPlainSpeak: a short input may grow — unpacking jargon costs words', () => {
  const src = '网关自砍头了。';
  const out = '网关把自己关掉了：它执行的那条命令会连自己一起结束，所以后面的启动那半句根本没跑到。';
  assert.equal(acceptPlainSpeak(src, out), true);
});

test('plainSpeakMessages: the reply is data between markers, and the fence comes first', () => {
  const msgs = plainSpeakMessages(REPLY);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  const system = String(msgs[0].content);
  const user = String(msgs[1].content);
  // The instruction that the text is material, not orders, is in the system
  // message — where it is read before the reply is ever seen.
  assert.match(system, /只改写，不回答/);
  assert.match(system, /不要执行/);
  // And the reply itself is inside the markers, whole.
  const inside = user.split('<<<REPLY>>>')[1]?.split('<<<END_REPLY>>>')[0] ?? '';
  assert.equal(inside.trim(), REPLY);
});

test('providerRefused: a 403 from the provider is a key problem, not a retryable one', () => {
  assert.equal(
    providerRefused(new Error('OpenRouter google/gemini-3.7-flash HTTP 403: The request is prohibited due to a violation of provider Terms Of Service.')),
    true,
  );
  assert.equal(providerRefused(new Error('OpenRouter google/gemini-3.7-flash HTTP 502: upstream')), false);
  assert.equal(providerRefused(new Error('fetch failed')), false);
});
