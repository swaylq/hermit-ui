import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSearchText } from './chat-text';

test('keeps text blocks, joined by newline', () => {
  const out = extractSearchText([
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ]);
  assert.equal(out, 'first\nsecond');
});

test('a query cannot match across a block boundary', () => {
  // Concatenating (the display helper's behaviour) would produce "abcdef" and
  // let "cd" match something no single block contains.
  const out = extractSearchText([
    { type: 'text', text: 'abc' },
    { type: 'text', text: 'def' },
  ]);
  assert.equal(out.includes('cd'), false);
});

test('drops the block types the cache deliberately excludes', () => {
  const out = extractSearchText([
    { type: 'thinking', thinking: 'private reasoning' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', tool_use_id: 't1', content: 'a directory listing' },
    { type: 'image', source: { data: 'AAAA' } },
    { type: 'text', text: '好的' },
  ]);
  assert.equal(out, '好的');
});

test('handles a bare string content column', () => {
  assert.equal(extractSearchText('  hello  '), 'hello');
});

test('survives malformed content without throwing', () => {
  assert.equal(extractSearchText(null), '');
  assert.equal(extractSearchText(undefined), '');
  assert.equal(extractSearchText({ nope: true }), '');
  assert.equal(extractSearchText([null, 42, { type: 'text' }, { type: 'text', text: 'ok' }]), 'ok');
});

test('skips whitespace-only text blocks', () => {
  assert.equal(extractSearchText([{ type: 'text', text: '   ' }, { type: 'text', text: 'x' }]), 'x');
});
