import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPreviewElementPick, readPreviewElementPick } from './preview-element-pick';

test('a picked element gives the composer both a concise selector and its full DOM path', () => {
  const pick = readPreviewElementPick({
    selector: 'button[data-testid="save"]',
    selectorPath: 'body > div#root > main > button[data-testid="save"]',
    tag: 'BUTTON',
    label: 'Save changes',
    text: 'Save',
  });

  assert.ok(pick);
  assert.equal(
    formatPreviewElementPick(pick),
    '`button[data-testid="save"]`（标签 `button`；完整路径 `body > div#root > main > button[data-testid="save"]`；名称 "Save changes"；文本 "Save"）',
  );
});

test('an old bridge still contributes its tag and visible text', () => {
  const pick = readPreviewElementPick({ selector: '#title', tag: 'h1', text: '  Page   A  ' });
  assert.ok(pick);
  assert.equal(formatPreviewElementPick(pick), '`#title`（标签 `h1`；文本 "Page A"）');
});

test('invalid optional fields are discarded and an invalid selector rejects the message', () => {
  assert.equal(readPreviewElementPick({ selector: '' }), null);
  assert.deepEqual(readPreviewElementPick({ selector: '.card', tag: '<script>', selectorPath: 'x'.repeat(4_001) }), {
    selector: '.card',
  });
});

test('selectors containing backticks remain valid inline Markdown', () => {
  assert.equal(formatPreviewElementPick({ selector: '[data-value="a`b"]' }), '``[data-value="a`b"]``');
});
