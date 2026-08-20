import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAttachments, officeHint, isImage } from './attachments';

const hintsFor = (p: string, nativeImages = false) =>
  planAttachments([p], { nativeImages }).hints.join('\n');

// ── images: the one thing that differs by backend ───────────────────────────

test('a backend that takes content blocks gets the image, not a path', () => {
  const plan = planAttachments(['/c/shot.png'], { nativeImages: true });
  assert.deepEqual(plan.images, [{ path: '/c/shot.png', mediaType: 'image/png' }]);
  assert.deepEqual(plan.hints, [], 'no Read line — the bytes go in the request');
});

test('a backend that cannot carry binary gets a Read line instead', () => {
  const plan = planAttachments(['/c/shot.png'], { nativeImages: false });
  assert.deepEqual(plan.images, []);
  assert.deepEqual(plan.hints, ['Read /c/shot.png']);
});

test('every image extension the relay caches is recognised', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
    assert.equal(isImage(`/c/x.${ext}`), true, ext);
    assert.equal(planAttachments([`/c/x.${ext}`], { nativeImages: true }).images.length, 1, ext);
  }
});

test('extension matching is case-insensitive', () => {
  assert.equal(isImage('/c/SHOT.PNG'), true);
});

// ── binaries: identical advice on every backend ─────────────────────────────
//
// Reading any of these directly puts megabytes of gibberish in the context. The
// advice is what makes an upload usable, so it must not depend on which backend
// happens to be driving.

test('an archive is extracted, never Read', () => {
  for (const ext of ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'zst']) {
    const h = hintsFor(`/c/a.${ext}`);
    assert.match(h, /do NOT Read it directly/, ext);
    assert.match(h, /unzip \/ tar -xf/, ext);
  }
});

test('audio is transcribed, never Read', () => {
  const h = hintsFor('/c/voice.m4a');
  assert.match(h, /do NOT Read it directly/);
  assert.match(h, /whisper/);
});

test('video is probed and sampled into frames, never Read', () => {
  const h = hintsFor('/c/clip.mp4');
  assert.match(h, /ffprobe/);
  assert.match(h, /extract frames/);
});

test('office documents each get their own conversion route', () => {
  assert.match(hintsFor('/c/d.docx'), /textutil -convert txt/);
  assert.match(hintsFor('/c/s.xlsx'), /pd\.read_excel/);
  assert.match(hintsFor('/c/p.pptx'), /ppt\/slides\/slide\*\.xml/);
  // The open-document twins route the same way.
  assert.match(hintsFor('/c/d.odt'), /textutil/);
  assert.match(hintsFor('/c/s.ods'), /read_excel/);
  assert.match(hintsFor('/c/p.odp'), /slides/);
});

test('officeHint declines anything it has no route for', () => {
  assert.equal(officeHint('/c/notes.txt'), null);
  assert.equal(officeHint('/c/shot.png'), null);
  assert.equal(officeHint('/c/noext'), null);
});

// The default for anything unrecognised: a text file, a log, a csv — Read is
// exactly right for those, and guessing further would be worse than not.
test('an ordinary file is simply Read', () => {
  assert.deepEqual(planAttachments(['/c/notes.md'], { nativeImages: true }).hints, ['Read /c/notes.md']);
  assert.deepEqual(planAttachments(['/c/data.csv'], { nativeImages: true }).hints, ['Read /c/data.csv']);
  assert.deepEqual(planAttachments(['/c/noext'], { nativeImages: true }).hints, ['Read /c/noext']);
});

// ── mixed batches ───────────────────────────────────────────────────────────

test('a mixed batch splits by kind and keeps attachment order', () => {
  const plan = planAttachments(
    ['/c/1.png', '/c/report.xlsx', '/c/2.jpg', '/c/logs.txt'],
    { nativeImages: true },
  );
  assert.deepEqual(plan.images.map((i) => i.path), ['/c/1.png', '/c/2.jpg']);
  assert.equal(plan.hints.length, 2);
  assert.match(plan.hints[0], /read_excel/);
  assert.equal(plan.hints[1], 'Read /c/logs.txt');
});

test('no attachments means no work', () => {
  assert.deepEqual(planAttachments([], { nativeImages: true }), { images: [], hints: [] });
  assert.deepEqual(planAttachments([], { nativeImages: false }), { images: [], hints: [] });
});
