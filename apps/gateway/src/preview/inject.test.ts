import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInsertPoint, htmlInjector, injectIntoHtml, reloadSnippet } from './reload';
import { bridgeSnippet } from './bridge';
import { stripAntiEmbed } from './serve';

// What is injected into a preview page is the one piece of hermit that runs
// inside somebody else's document. It cannot be unit-tested for behaviour here
// (there is no DOM in this process — the picker and the history bookkeeping are
// exercised in a browser), so what IS tested is the part that breaks pages:
// where the script lands, whether it parses, and whether it can end the <script>
// element it is written into.

const PAGE = '<!doctype html><html><head><title>t</title></head><body><h1>hi</h1></body></html>';

test('the bridge lands inside the document, at the end of <head>', () => {
  const out = injectIntoHtml(PAGE, 'pv_x', true);
  const bridgeAt = out.indexOf('data-hermit-preview-bridge');
  assert.ok(bridgeAt > 0);
  assert.ok(bridgeAt < out.indexOf('</head>'));
  assert.ok(out.startsWith('<!doctype html>'));
});

test('with no head it falls back to the end of body', () => {
  const out = injectIntoHtml('<html><body><h1>hi</h1></body></html>', 'pv_x', true);
  assert.ok(out.indexOf('data-hermit-preview-bridge') < out.indexOf('</body>'));
});

test('the insertion point is found whatever the case', () => {
  assert.equal(findInsertPoint('<HTML><HEAD></HEAD>'), '<HTML><HEAD>'.length);
  assert.equal(findInsertPoint('<p>no document here</p>'), -1);
});

test('a document with no </body> still gets it, appended', () => {
  const out = injectIntoHtml('<h1>fragment</h1>', 'pv_x', true);
  assert.ok(out.startsWith('<h1>fragment</h1>'));
  assert.ok(out.includes('data-hermit-preview-bridge'));
});

test('nothing to watch means no reload client — but always a bridge', () => {
  const withWatch = injectIntoHtml(PAGE, 'pv_x', true);
  const without = injectIntoHtml(PAGE, 'pv_x', false);
  assert.ok(withWatch.includes('__hermit__/sse'));
  assert.ok(!without.includes('__hermit__/sse'));
  assert.ok(without.includes('data-hermit-preview-bridge'));
});

test('the reload client points at the preview it was injected for', () => {
  assert.ok(reloadSnippet('pv_abc').includes('/p/pv_abc/__hermit__/sse'));
});

test('neither snippet can close the script element it lives in', () => {
  // '</script' anywhere in the source ends the element early and dumps the rest
  // of the client into the page as text; '<!--' flips the parser into comment
  // state and can swallow the document's real markup.
  for (const s of [bridgeSnippet(), reloadSnippet('pv_x')]) {
    const body = s.slice(s.indexOf('>') + 1, s.lastIndexOf('</script>'));
    assert.ok(!/<\/script/i.test(body), 'script body closes itself');
    assert.ok(!body.includes('<!--'), 'script body opens an HTML comment');
    assert.ok(!/<script/i.test(body), 'script body opens a nested script');
  }
});

test('the bridge is syntactically valid JavaScript', () => {
  const s = bridgeSnippet();
  const body = s.slice(s.indexOf('>') + 1, s.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(body)); // compiled, never run — there is no window here
});

test('the bridge answers to the protocol the panel speaks', () => {
  const body = bridgeSnippet();
  for (const token of ['hermit-preview-page', "'nav'", "'reload'", "'pick'", "'hello'", "'picked'", "'state'"]) {
    assert.ok(body.includes(token), `missing ${token}`);
  }
});

// ── the streaming injector (proxy mode) ──────────────────────────────────────

/** Push `chunks` through the transform and return what came out the other side. */
async function through(chunks: string[], withReload = true): Promise<string> {
  const t = htmlInjector('pv_x', withReload);
  const out: Buffer[] = [];
  t.on('data', (c: Buffer) => out.push(c));
  const done = new Promise<void>((r) => t.on('end', () => r()));
  for (const c of chunks) t.write(Buffer.from(c, 'utf8'));
  t.end();
  await done;
  return Buffer.concat(out).toString('utf8');
}

test('streamed HTML is spliced, not rewritten', async () => {
  const out = await through([PAGE]);
  assert.ok(out.startsWith('<!doctype html><html><head><title>t</title>'));
  assert.ok(out.endsWith('</head><body><h1>hi</h1></body></html>'));
  assert.ok(out.includes('data-hermit-preview-bridge'));
});

test('an insertion point split across chunks is still found', async () => {
  // The dev server has no obligation to end a chunk anywhere convenient.
  const out = await through(['<html><he', 'ad><title>t</ti', 'tle></he', 'ad><body>x</body></html>']);
  assert.equal((out.match(/data-hermit-preview-bridge/g) ?? []).length, 1);
  assert.ok(out.indexOf('data-hermit-preview-bridge') < out.indexOf('</head>'));
});

test('the tail is passed through after the splice, byte for byte', async () => {
  const tail = '<body>' + 'x'.repeat(5000) + '</body></html>';
  const out = await through(['<html><head></head>', tail]);
  assert.ok(out.endsWith(tail));
});

test('the splice happens before the stream ends — a streaming server is not held', async () => {
  const t = htmlInjector('pv_x', true);
  const seen: Buffer[] = [];
  t.on('data', (c: Buffer) => seen.push(c));
  t.write(Buffer.from('<html><head></head><body>first', 'utf8'));
  await new Promise((r) => setImmediate(r));
  // Nothing has ended; the head of the document must already be out the door.
  assert.ok(Buffer.concat(seen).toString('utf8').includes('data-hermit-preview-bridge'));
  t.destroy();
});

test('markup that never shows an insertion point still gets the script, at the end', async () => {
  const out = await through(['<p>just a fragment</p>']);
  assert.ok(out.startsWith('<p>just a fragment</p>'));
  assert.ok(out.includes('data-hermit-preview-bridge'));
});

test('a multi-byte character split across chunks survives the splice', async () => {
  const cn = Buffer.from('<html><head></head><body>中文</body></html>', 'utf8');
  const cut = cn.indexOf(Buffer.from('中')) + 1; // mid-character
  const t = htmlInjector('pv_x', true);
  const out: Buffer[] = [];
  t.on('data', (c: Buffer) => out.push(c));
  const done = new Promise<void>((r) => t.on('end', () => r()));
  t.write(cn.subarray(0, cut));
  t.write(cn.subarray(cut));
  t.end();
  await done;
  assert.ok(Buffer.concat(out).toString('utf8').includes('中文'));
});

test('the streamed splice matches the read-from-disk one', async () => {
  assert.equal(await through([PAGE], false), injectIntoHtml(PAGE, 'pv_x', false));
});

// ── the insertion point is not fooled by text that looks like markup ─────────

const HEAD_IN_SCRIPT =
  '<!doctype html><html><head><script>var t="</head>";</script><title>t</title></head><body>x</body></html>';

test('a </head> inside an inline script is text, not the head', () => {
  const out = injectIntoHtml(HEAD_IN_SCRIPT, 'pv_x', true);
  assert.ok(out.includes('var t="</head>";'), 'the script was cut open');
  assert.ok(out.indexOf('data-hermit-preview-bridge') > out.indexOf('<title>'));
});

test('a </head> inside a comment is text too', () => {
  const html = '<html><head><!-- </head> --><title>t</title></head><body>x</body></html>';
  const out = injectIntoHtml(html, 'pv_x', true);
  assert.ok(out.includes('<!-- </head> -->'), 'the comment was cut open');
  assert.ok(out.indexOf('data-hermit-preview-bridge') > out.indexOf('<title>'));
});

test('a </head> inside a title is text too', () => {
  const html = '<html><head><title>a </head> b</title></head><body>x</body></html>';
  const out = injectIntoHtml(html, 'pv_x', true);
  assert.ok(out.includes('<title>a </head> b</title>'));
});

test('an element whose name merely starts with a raw-text one is an ordinary tag', () => {
  // <style-guide> must not swallow the rest of the document as CSS.
  const html = '<html><head><style-guide></style-guide></head><body>x</body></html>';
  const out = injectIntoHtml(html, 'pv_x', true);
  assert.ok(out.indexOf('data-hermit-preview-bridge') < out.indexOf('</head>'));
});

test('the streamed scan is not fooled either, whatever the chunking', async () => {
  for (const size of [1, 3, 7, 16, 64]) {
    const chunks: string[] = [];
    for (let i = 0; i < HEAD_IN_SCRIPT.length; i += size) chunks.push(HEAD_IN_SCRIPT.slice(i, i + size));
    const out = await through(chunks);
    assert.ok(out.includes('var t="</head>";'), `chunk size ${size}: the script was cut open`);
    assert.equal((out.match(/data-hermit-preview-bridge/g) ?? []).length, 1, `chunk size ${size}: not spliced once`);
    assert.equal(out.replace(/<script data-hermit-preview.*?<\/script>/gs, ''), HEAD_IN_SCRIPT, `chunk size ${size}: document changed`);
  }
});

test('byte-for-byte, the only change to a document is the snippet', async () => {
  const out = await through([PAGE]);
  assert.equal(out.replace(/<script data-hermit-preview.*?<\/script>/gs, ''), PAGE);
});

// ── living with the app's own Content-Security-Policy ────────────────────────

test('the snippets carry the nonce they were given', () => {
  const out = injectIntoHtml(PAGE, 'pv_x', true, 'abc+/=123');
  assert.equal((out.match(/nonce="abc\+\/=123"/g) ?? []).length, 2); // reload client + bridge
});

test('a nonce that could break out of the attribute is refused, not escaped', () => {
  assert.ok(!injectIntoHtml(PAGE, 'pv_x', true, 'a"><img src=x>').includes('nonce='));
  assert.ok(!injectIntoHtml(PAGE, 'pv_x', true, '').includes('nonce='));
});

test('frame-ancestors goes; the rest of the policy stays', () => {
  const out = stripAntiEmbed({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" });
  assert.equal(out['content-security-policy'], "default-src 'self'");
  assert.equal(stripAntiEmbed({ 'x-frame-options': 'DENY' })['x-frame-options'], undefined);
});

test('the nonce is allowed through script-src rather than the directive being dropped', () => {
  const out = stripAntiEmbed({ 'content-security-policy': "default-src 'self'; script-src 'self'" }, 'N1');
  assert.equal(out['content-security-policy'], "default-src 'self'; script-src 'self' 'nonce-N1'");
});

test('with no script-src it goes through default-src, which script-src falls back to', () => {
  const out = stripAntiEmbed({ 'content-security-policy': "default-src 'self'" }, 'N1');
  assert.equal(out['content-security-policy'], "default-src 'self' 'nonce-N1'");
});

test('a policy that restricts neither is left exactly as it was', () => {
  const out = stripAntiEmbed({ 'content-security-policy': "img-src 'self'" }, 'N1');
  assert.equal(out['content-security-policy'], "img-src 'self'");
});
