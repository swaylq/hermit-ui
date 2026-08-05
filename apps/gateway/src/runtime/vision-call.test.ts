import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatVision, VISION_DEFAULTS } from './vision-call';

// The injected text is what a model with no eyes actually reads, so an empty
// section must not render as a claim. The old formatter printed
// "OCR 文字：（无）" whenever a provider filled only one field — which reads as
// "the OCR ran and found no text", a different thing from "no OCR pass ran".
test('an empty section is omitted, not printed as （无）', () => {
  const out = formatVision(
    { provider: 'openrouter', ocr: '', description: '左上角是标题栏' },
    '/tmp/a.png',
  );

  assert.match(out, /布局描述/);
  assert.doesNotMatch(out, /OCR 文字/);
  assert.doesNotMatch(out, /（无）/);
});

test('both sections render when both passes returned something', () => {
  const out = formatVision(
    { provider: 'dashscope', ocr: '登录', description: '一个登录框' },
    '/tmp/b.png',
  );

  assert.match(out, /【OCR 文字】\n登录/);
  assert.match(out, /【布局描述】\n一个登录框/);
});

// A single-model provider answering the same text twice used to print the same
// paragraph under two headings.
test('identical ocr and description are not printed twice', () => {
  const out = formatVision(
    { provider: 'openrouter', ocr: 'same text', description: 'same text' },
    '/tmp/c.png',
  );

  assert.equal(out.match(/same text/g)?.length, 1);
});

test('the image path is always carried so the agent can re-inspect it', () => {
  const path = '/var/folders/x/upload-9.png';
  assert.match(formatVision({ provider: 'openrouter', ocr: 'hi', description: '' }, path), /upload-9\.png/);
  assert.match(formatVision({ provider: 'openrouter', ocr: '', description: '' }, path), /upload-9\.png/);
});

test('a total failure says so instead of returning an empty block', () => {
  const out = formatVision(
    { provider: 'openrouter', ocr: '', description: '', error: '429 rate limited' },
    '/tmp/d.png',
  );

  assert.match(out, /429 rate limited/);
});

test('a half-failure still delivers the half that worked', () => {
  const out = formatVision(
    { provider: 'openrouter', ocr: '扫描到的文字', description: '', error: '描述: 500' },
    '/tmp/e.png',
  );

  assert.match(out, /扫描到的文字/);
  assert.match(out, /部分识别失败/);
});

// Defaults are load-bearing: visionEnv() no longer sends a model name when the
// operator left the field blank, so the child resolves it from here. If these
// two disagreed, the settings page would show one model and the child would run
// another — which is the bug that made OpenRouter behave differently in chat
// than in the describe_image tool.
test('every provider has a usable default pair', () => {
  for (const [provider, models] of Object.entries(VISION_DEFAULTS)) {
    assert.ok(models.ocr, `${provider} needs a default OCR model`);
    assert.ok(models.describe, `${provider} needs a default describe model`);
  }
});
