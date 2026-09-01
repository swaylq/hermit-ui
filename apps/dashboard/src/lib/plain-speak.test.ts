import test from 'node:test';
import assert from 'node:assert/strict';
import { canPlainSpeak, plainKey } from './plain-speak';

test('canPlainSpeak: an acknowledgement is not worth rewriting', () => {
  assert.equal(canPlainSpeak('好的'), false);
  assert.equal(canPlainSpeak('已部署，dashboard 返回 200。'), false);
  assert.equal(canPlainSpeak(''), false);
  assert.equal(canPlainSpeak('   \n  '), false);
});

test('canPlainSpeak: a paragraph of prose is', () => {
  const reply =
    '网关那条链路现在收敛到同一个函数了，三个入口不再各自为政；' +
    '代价是每轮多付一次序列化，实测在 p95 上多出 8 毫秒，可以接受。' +
    '剩下的事情是把旧的调用点删掉，等你点头再动。';
  assert.equal(canPlainSpeak(reply), true);
});

test('canPlainSpeak: a wall of file paths is not prose', () => {
  const paths = [
    'apps/dashboard/src/lib/translate-text.ts',
    'apps/dashboard/src/lib/translate-store.ts',
    'apps/dashboard/src/components/chat/message-timeline.tsx',
    'apps/gateway/src/runtime/pi-credentials.ts',
  ].join('\n');
  assert.equal(canPlainSpeak(paths), false);
});

test('canPlainSpeak: English replies qualify too', () => {
  const reply =
    'The gateway now resolves every backend through one code path, so the three ' +
    'entry points cannot drift apart any more. It costs one extra serialisation ' +
    'per turn, which measured as eight milliseconds at p95.';
  assert.equal(canPlainSpeak(reply), true);
});

test('plainKey: stable, and separate from the translation namespace', () => {
  const a = plainKey('把网关重启一遍就好了');
  assert.equal(a, plainKey('把网关重启一遍就好了'));
  assert.notEqual(a, plainKey('把网关重启两遍就好了'));
  assert.ok(a.startsWith('plain1:'));
});
