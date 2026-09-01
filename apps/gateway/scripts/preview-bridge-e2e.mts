// E2E: the preview panel's in-page bridge (src/preview/bridge.ts), in a real browser.
//
//   cd apps/gateway && npx tsx scripts/preview-bridge-e2e.mts
//   BROWSER=webkit npx tsx scripts/preview-bridge-e2e.mts   # Safari's engine
//
// Not part of `npm test`: it needs a browser and a spare port. It is the ONLY
// coverage the bridge can have — every line of it is DOM behaviour (history
// traversal, event capture, selector synthesis), none of which exists in a Node
// process. The unit test next to it (src/preview/inject.test.ts) can only prove
// the script parses and lands in the right place.
//
// It has already earned its keep: it caught a pick started inside the previous
// pick's click-swallow window being silently disarmed, so the second element you
// clicked followed its link instead of being picked.
//
// Shape: one server on 4199, serving a parent page on localhost and the frame
// pages on 127.0.0.1 — same process, different origins, so the postMessage path
// under test is the cross-origin one the dashboard actually uses.

import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { chromium, webkit } from 'playwright-core';
import { htmlInjector, injectIntoHtml } from '../src/preview/reload.ts';
import { stripAntiEmbed } from '../src/preview/serve.ts';

const PORT = Number(process.env.PORT ?? 4199);
const PARENT = `http://localhost:${PORT}/parent.html`;
const FRAME = `http://127.0.0.1:${PORT}`;
/** WebKit takes appreciably longer to settle a cross-origin frame navigation than Chrome. */
const SETTLE = Number(process.env.SETTLE ?? (process.env.BROWSER === 'webkit' ? 900 : 400));

let pass = 0,
  fail = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✔ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✘ ${label} ${detail}`);
  }
}
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `— got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the pages ────────────────────────────────────────────────────────────────

const shell = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font:14px system-ui;margin:20px}.card{padding:12px;border:1px solid #ccc;margin:8px 0}</style>` +
  `</head><body>${body}</body></html>`;

const PAGE_A = shell(
  'page A',
  `<h1 id="title">Page A</h1>
   <div class="wrap">
     <div class="card"><p>first card</p></div>
     <div class="card"><p class="lead">second card</p><button class="btn" data-testid="save" aria-label="Save changes">Save</button></div>
     <div class="card"><p>third card</p></div>
   </div>
   <ul><li>one</li><li>two</li><li id="li-three">three</li></ul>
   <a id="to-b" href="/b.html">go to B</a>`,
);
const PAGE_B = shell('page B', `<h1>Page B</h1><a id="to-a" href="/a.html">back to A</a>`);

// The panel's half of the protocol, cut down to what the assertions need — same
// message names, same origin/source checks, same push-vs-traverse bookkeeping as
// components/chat/preview-panel.tsx.
const PARENT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>bridge e2e</title></head><body>
<iframe id="f" src="${FRAME}/a.html" style="width:600px;height:400px;border:1px solid #999"
  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"></iframe>
<script>
(function(){
  var ORIGIN = ${JSON.stringify(FRAME)};
  var hist = { idx: 0, max: 0, pending: null, len: null };
  var st = { ready:false, back:false, fwd:false, url:'', idx:0, max:0, picks:[], log:[] };
  window.__hp = st;
  window.addEventListener('message', function(e){
    if (e.origin !== ORIGIN) return;
    if (e.source !== document.getElementById('f').contentWindow) return;
    var d = e.data;
    if (!d || d.source !== 'hermit-preview-page') return;
    st.log.push(d);
    if (d.type === 'state') {
      st.ready = true; st.url = d.url;
      var len = typeof d.len === 'number' ? d.len : null;
      var pending = hist.pending; hist.pending = null;
      if (pending != null) hist.idx = Math.max(0, Math.min(hist.max, hist.idx + pending));
      else if (hist.len != null && len != null && len > hist.len) { hist.idx += 1; hist.max = hist.idx; }
      hist.len = len;
      st.idx = hist.idx; st.max = hist.max;
      if (d.can && typeof d.can.back === 'boolean') { st.back = d.can.back; st.fwd = !!d.can.fwd; }
      else { st.back = hist.idx > 0; st.fwd = hist.idx < hist.max; }
    } else if (d.type === 'picked') { st.picks.push(d); }
  });
  window.__post = function(m){ m.source='hermit-preview'; m.v=1; document.getElementById('f').contentWindow.postMessage(m, ORIGIN); };
  window.__go = function(delta){ hist.pending = delta; window.__post({type:'nav', delta:delta}); };
  window.__pick = function(on){ window.__post({type:'pick', on:on}); };
})();
</script></body></html>`;

// A serves through the static path's string splice, B through the proxy path's
// streaming one — in three chunks, so the whole run exercises both injectors and
// a chunk boundary lands mid-document.
const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

const server = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  if (p === '/parent.html') {
    res.writeHead(200, HTML);
    return res.end(PARENT_PAGE);
  }
  if (p === '/a.html') {
    res.writeHead(200, HTML);
    return res.end(injectIntoHtml(PAGE_A, 'pv_e2e', true));
  }
  if (p === '/b.html') {
    // …and under a policy that forbids inline script, so the nonce path is what
    // the browser is actually judging, not something a unit test asserts about.
    const nonce = crypto.randomBytes(16).toString('base64');
    res.writeHead(200, {
      ...HTML,
      ...stripAntiEmbed({ 'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none'" }, nonce),
    });
    const n = Math.ceil(PAGE_B.length / 3);
    const parts = [PAGE_B.slice(0, n), PAGE_B.slice(n, 2 * n), PAGE_B.slice(2 * n)];
    return Readable.from(parts).pipe(htmlInjector('pv_e2e', true, nonce)).pipe(res);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('nope');
});
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));

// ── drive it ─────────────────────────────────────────────────────────────────

// Chrome is the system install (playwright-core ships no browser binaries).
// WebKit has none to borrow, so it needs `npx playwright install webkit` first —
// worth doing before touching the bridge, since it is the engine on sway's phone.
const browser = await (process.env.BROWSER === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chrome' })).catch(
  (e: Error) => {
    console.error(
      process.env.BROWSER === 'webkit'
        ? 'webkit not installed for playwright-core — run `npx playwright install webkit`, or drop BROWSER=webkit to use system Chrome'
        : `no system Chrome to drive — ${e.message.split('\n')[0]}`,
    );
    process.exit(2);
  },
);
const page = await browser.newPage();
const frame = page.frameLocator('#f');
const state = () => page.evaluate(() => JSON.parse(JSON.stringify((window as never as { __hp: unknown }).__hp))) as Promise<{
  ready: boolean;
  url: string;
  back: boolean;
  fwd: boolean;
  idx: number;
  max: number;
  picks: Array<{ selector: string; selectorPath: string; tag: string; label: string; text: string }>;
}>;
const settle = () => page.waitForTimeout(SETTLE);

async function pickIt(locator: string) {
  await page.evaluate(() => {
    const w = window as never as { __hp: { picks: unknown[] }; __pick: (on: boolean) => void };
    w.__hp.picks.length = 0;
    w.__pick(true);
  });
  await page.waitForTimeout(150);
  await frame.locator(locator).hover();
  await page.waitForTimeout(150);
  await frame.locator(locator).click();
  await page.waitForTimeout(300);
  return (await state()).picks[0] ?? {
    selector: '<none>', selectorPath: '<none>', tag: '<none>', label: '<none>', text: '<none>',
  };
}

try {
  await page.goto(PARENT);
  await settle();

  console.log('history');
  let s = await state();
  check('the bridge announces itself', s.ready);
  eq('it reports the frame url', s.url, `${FRAME}/a.html`);
  eq('nothing behind us at the first entry', [s.back, s.fwd], [false, false]);

  await frame.locator('#to-b').click();
  await settle();
  s = await state();
  eq('a followed link is reported', s.url, `${FRAME}/b.html`);
  eq('and puts an entry behind us', [s.back, s.fwd], [true, false]);
  eq('the no-Navigation-API fallback counts it the same way', [s.idx, s.max], [1, 1]);

  await page.evaluate(() => (window as never as { __go: (d: number) => void }).__go(-1));
  await settle();
  s = await state();
  eq('back returns to the previous page', s.url, `${FRAME}/a.html`);
  eq('back opens the way forward', [s.back, s.fwd], [false, true]);
  eq('the fallback counter follows the traversal', [s.idx, s.max], [0, 1]);
  eq('the top-level document did not move', page.url(), PARENT);

  await page.evaluate(() => (window as never as { __go: (d: number) => void }).__go(1));
  await settle();
  s = await state();
  eq('forward goes back to where we were', s.url, `${FRAME}/b.html`);
  eq('and closes the way forward again', [s.back, s.fwd], [true, false]);

  await page.evaluate(() => (window as never as { __post: (m: unknown) => void }).__post({ type: 'reload' }));
  await settle();
  s = await state();
  eq('reload stays on the page', s.url, `${FRAME}/b.html`);
  check('reload keeps the history remounting would have thrown away', s.back);

  // The one that can hurt: an iframe traversing past its own first entry walks
  // the joint history and takes the whole dashboard with it.
  await page.evaluate(() => (window as never as { __go: (d: number) => void }).__go(-1));
  await settle();
  await page.evaluate(() => (window as never as { __post: (m: unknown) => void }).__post({ type: 'nav', delta: -1 }));
  await settle();
  eq('one entry too far leaves the top-level alone', page.url(), PARENT);
  eq('and leaves the frame alone', (await state()).url, `${FRAME}/a.html`);

  console.log('picker');
  let p = await pickIt('#title');
  eq('an element with a usable id is named by it', p.selector, '#title');
  eq('and its complete path keeps the tag and page context', p.selectorPath, 'body > h1#title');

  p = await pickIt('[data-testid="save"]');
  eq('a test attribute beats classes', p.selector, 'button[data-testid="save"]');
  eq(
    'the complete path reaches it from the page body',
    p.selectorPath,
    'body > div.wrap > div.card:nth-of-type(2) > button[data-testid="save"]',
  );
  eq('its accessible name is included for icon and labelled controls', p.label, 'Save changes');
  eq('the picked element is described too', p.text, 'Save');

  p = await pickIt('.wrap > div:nth-child(3) > p');
  check('an ambiguous element gets a disambiguated path', /nth-of-type/.test(p.selector), `— got ${p.selector}`);
  const hits = await frame
    .locator('body')
    .evaluate((b, sel) => {
      try {
        return b.ownerDocument.querySelectorAll(sel).length;
      } catch {
        return -1;
      }
    }, p.selector);
  eq(`"${p.selector}" resolves to exactly one element`, hits, 1);
  const pathHits = await frame
    .locator('body')
    .evaluate((b, sel) => {
      try {
        return b.ownerDocument.querySelectorAll(sel).length;
      } catch {
        return -1;
      }
    }, p.selectorPath);
  eq(`its complete path also resolves to exactly one element`, pathHits, 1);

  p = await pickIt('#li-three');
  eq('a list item keeps its id', p.selector, '#li-three');

  p = await pickIt('p.lead');
  eq('a distinctive class is enough on its own', p.selector, 'p.lead');

  const before = (await state()).url;
  p = await pickIt('#to-b');
  await settle();
  eq('picking a link does not follow it', (await state()).url, before);
  eq('but it still yields a selector', p.selector, '#to-b');

  await page.evaluate(() => (window as never as { __pick: (on: boolean) => void }).__pick(true));
  await page.waitForTimeout(150);
  await frame.locator('#title').hover();
  await page.waitForTimeout(150);
  await page.evaluate(() => (window as never as { __pick: (on: boolean) => void }).__pick(false));
  await page.waitForTimeout(200);
  const left = await frame.locator('body').evaluate((b) => {
    const d = b.ownerDocument;
    const nodes = Array.from(d.querySelectorAll('[data-hermit-preview-pick]'));
    return {
      visible: nodes.filter((el) => el.tagName !== 'STYLE' && (el as HTMLElement).style.display !== 'none').length,
      styles: d.querySelectorAll('style[data-hermit-preview-pick]').length,
    };
  });
  eq('cancelling leaves nothing of the picker on screen', left.visible, 0);
  eq('and takes the crosshair cursor back', left.styles, 0);

  await frame.locator('#to-b').click();
  await settle();
  eq('after cancelling, clicks reach the page again', (await state()).url, `${FRAME}/b.html`);
} catch (e) {
  fail += 1;
  console.log(`  ✘ ran to completion — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
