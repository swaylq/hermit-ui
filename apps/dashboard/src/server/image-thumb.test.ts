import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeThumb } from './image-thumb';

// A 1x1 PNG. Small on purpose: what is under test is the OUTPUT FORMAT, not the
// resize — imagemagick reads its output format from the file extension, so
// writing the temp file as `<name>.tmp` silently produced a PNG wearing a .webp
// name in production (2026-08-25, a 407KB "thumbnail"). Anything that reads the
// extension again will reintroduce it; this test is the tripwire.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function haveEncoder(): boolean {
  return ['convert', 'sips'].some((b) => spawnSync('which', [b]).status === 0);
}

// RIFF....WEBP — bytes 0-3 and 8-11 of every WebP file.
function isWebp(buf: Buffer): boolean {
  return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}

test('makeThumb writes a real WebP, whatever the temp file is called', { skip: !haveEncoder() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
  const src = join(dir, 'src.png');
  const out = join(dir, 'src.thumb.webp');
  writeFileSync(src, Buffer.from(PNG_1X1, 'base64'));

  assert.equal(makeThumb(src, out), true, 'an encoder is present, so this must succeed');
  assert.ok(existsSync(out));
  assert.ok(isWebp(readFileSync(out)), 'output must be WebP, not the source format renamed');
  // no temp files left behind
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp')), []);
});

test('makeThumb refuses a missing source instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
  assert.equal(makeThumb(join(dir, 'nope.png'), join(dir, 'nope.thumb.webp')), false);
  assert.deepEqual(readdirSync(dir), []);
});

test('makeThumb leaves nothing behind when the source is not an image', { skip: !haveEncoder() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
  const src = join(dir, 'notanimage.png');
  writeFileSync(src, 'this is not a picture');
  assert.equal(makeThumb(src, join(dir, 'notanimage.thumb.webp')), false);
  assert.deepEqual(readdirSync(dir), ['notanimage.png']);
});
