// The in-page half of the preview panel's browser chrome — injected into every
// HTML document a preview serves, alongside the auto-reload client (reload.ts).
//
// Why a script has to live in the page at all: preview.swaylab.ai is a DIFFERENT
// origin from dash.swaylab.ai, deliberately (agent-authored HTML must never run
// beside the dashboard's localStorage key ring). So the panel can touch neither
// `iframe.contentWindow.history` nor `contentDocument`; postMessage is the only
// channel there is, and a channel needs two ends.
//
// It gives the panel three things:
//   · back / forward      — history.go() run from inside the frame
//   · reload              — location.reload(), which keeps history where
//                           remounting the iframe would throw it away
//   · the element picker  — hover-highlight anything on the page, click it, and
//                           the parent gets a concise CSS selector plus its full
//                           DOM path and human-readable context
//
// Trust: the page posts to '*'. Everything it says (its own URL, a selector it
// was asked to produce) is already known to whoever holds the capability URL, so
// there is nothing here to leak. The PARENT is the side that authenticates —
// it checks event.origin and event.source before believing a word of this.
//
// Going back one entry too far inside a frame traverses the JOINT session
// history, i.e. it would navigate the whole dashboard away. Three things stop
// that: the parent only ever sends `back` while it believes an entry exists, the
// Navigation API check below refuses outright where it is implemented, and the
// iframe's sandbox withholds allow-top-navigation.

/**
 * A proxied app may send a CSP that forbids inline script. Rather than weaken
 * its policy we join it: serve.ts mints a nonce per response, allows that one
 * nonce through script-src, and stamps it on the snippets here.
 */
export function nonceAttr(nonce?: string | null): string {
  // Quote-safe by construction (base64, from serve.ts) — but never trusted from
  // here, because a nonce carrying a quote would break out of the attribute.
  return nonce && /^[A-Za-z0-9+/=_-]+$/.test(nonce) ? ` nonce="${nonce}"` : '';
}

/**
 * The bridge client. String.raw so the regexes and escapes below reach the
 * browser exactly as written; that also means no `${}` and no backticks in here.
 */
function bridgeClient(): string {
  return String.raw`(function () {
  if (window.__hermitPreviewBridge) return;
  window.__hermitPreviewBridge = 1;

  var IN = 'hermit-preview';         // parent -> page
  var OUT = 'hermit-preview-page';   // page -> parent
  var MAX_DEPTH = 8;
  var ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-id', 'name'];

  function up(msg) {
    try {
      msg.source = OUT;
      // 2 = "this page forwards the panel's dismissal drag" (see the touch
      // handlers below). The panel reads it as a capability and nothing else; a
      // page still speaking 1 keeps every other feature and gets an edge strip
      // of the panel's own to be dismissed from.
      msg.v = 2;
      if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
    } catch (e) {}
  }

  // ── where we are ────────────────────────────────────────────────────────
  // The Navigation API knows this frame's own back/forward availability, which
  // is the honest answer; history.length is the joint history and only useful
  // as a "did an entry get pushed" delta. Report both and let the parent prefer
  // the first when the browser has it.
  function report() {
    var n = window.navigation;
    var can = n && typeof n.canGoBack === 'boolean' ? { back: n.canGoBack, fwd: !!n.canGoForward } : null;
    up({ type: 'state', url: location.href, len: history.length, can: can });
  }

  addEventListener('pageshow', report);
  addEventListener('popstate', report);
  addEventListener('hashchange', report);
  try {
    if (window.navigation && window.navigation.addEventListener) {
      window.navigation.addEventListener('currententrychange', report);
    }
  } catch (e) {}
  // Same-document routing (any SPA) moves history without firing an event the
  // pre-Navigation-API browsers expose, so wrap the two methods that do it.
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    if (typeof orig !== 'function') return;
    history[k] = function () {
      var r = orig.apply(this, arguments);
      try { report(); } catch (e) {}
      return r;
    };
  });

  // ── selectors ───────────────────────────────────────────────────────────
  function esc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }

  // Framework-generated names (emotion hashes, Radix ids, Tailwind variants) are
  // worse than useless in a selector handed to a human: they change on the next
  // build. Keep short, wordy, hash-free identifiers only.
  function okIdent(s) {
    return !!s && s.length <= 40 && !/^[0-9]/.test(s) && !/[^\w-]/.test(s) &&
      !/[0-9]{4,}/.test(s) && !/-[0-9a-f]{6,}$/i.test(s) &&
      !/^(css|sc|jsx|emotion|chakra|mui|radix|headlessui)[-_]/i.test(s);
  }

  function classesOf(el) {
    var raw = (el.getAttribute('class') || '').split(/\s+/);
    var out = [];
    for (var i = 0; i < raw.length && out.length < 2; i++) if (okIdent(raw[i])) out.push('.' + esc(raw[i]));
    return out.join('');
  }

  function attrOf(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (v && v.length <= 60) return '[' + ATTRS[i] + '="' + v.replace(/["\\]/g, '\\$&') + '"]';
    }
    return '';
  }

  function nthOfType(el) {
    var n = 0, kids = el.parentElement ? el.parentElement.children : [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].tagName === el.tagName) { n++; if (kids[i] === el) return n; }
    }
    return 1;
  }

  function seg(el, tagId) {
    var tag = el.tagName.toLowerCase();
    if (el.id && okIdent(el.id) && uniq('#' + esc(el.id))) return (tagId ? tag : '') + '#' + esc(el.id);
    var s = tag + attrOf(el);
    if (s === tag) s = tag + classesOf(el);
    var p = el.parentElement;
    if (p) {
      var same = 0, kids = p.children;
      for (var i = 0; i < kids.length; i++) {
        var m = false;
        try { m = kids[i].matches(s); } catch (e) { m = kids[i].tagName === el.tagName; }
        if (m) same++;
      }
      // nth-of-type picks exactly one child, so it disambiguates whatever the
      // tag+class part left ambiguous.
      if (same > 1) s += ':nth-of-type(' + nthOfType(el) + ')';
    }
    return s;
  }

  function uniq(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }

  // Walk up until the chain matches exactly one element, then stop — the point
  // is the SHORTEST selector that still names this element and nothing else.
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    var parts = [], cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < MAX_DEPTH) {
      var s = seg(cur, false);
      parts.unshift(s);
      var joined = parts.join(' > ');
      if (uniq(joined)) return joined;
      if (s.charAt(0) === '#') break; // an id anchors it; going further up cannot help
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  // The concise selector above is ideal for code, but a bare #id or utility
  // class carries too little context in a chat prompt. Also send the complete
  // chain from body to the element. Every segment is unique among its siblings
  // (nth-of-type is added when needed), so the result remains a real selector,
  // not a decorative breadcrumb.
  function selectorPathFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    var parts = [], cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur === document.body) {
        parts.unshift('body');
        break;
      }
      parts.unshift(seg(cur, true));
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function labelFor(el) {
    var label = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.getAttribute('alt') || el.getAttribute('placeholder'));
    if (!label && el.labels && el.labels.length) {
      var parts = [];
      for (var i = 0; i < el.labels.length; i++) parts.push(el.labels[i].textContent || '');
      label = parts.join(' ');
    }
    return (label || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  // ── element picker ──────────────────────────────────────────────────────
  var picking = false, boxEl = null, tipEl = null, styleEl = null, lastEl = null, lastSel = '';
  var dropTimer = null;

  function chrome() {
    if (boxEl) return;
    boxEl = document.createElement('div');
    boxEl.setAttribute('data-hermit-preview-pick', '');
    boxEl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;' +
      'border:1px solid #3b82f6;background:rgba(59,130,246,.14);border-radius:2px;' +
      'box-shadow:0 0 0 1px rgba(255,255,255,.35)';
    tipEl = document.createElement('div');
    tipEl.setAttribute('data-hermit-preview-pick', '');
    tipEl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;' +
      'max-width:82vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'background:#111827;color:#fff;border-radius:4px;padding:3px 6px;' +
      'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace';
    var host = document.body || document.documentElement;
    host.appendChild(boxEl);
    host.appendChild(tipEl);
  }

  function paint() {
    if (!lastEl || !lastEl.isConnected) return;
    var r = lastEl.getBoundingClientRect();
    boxEl.style.display = 'block';
    boxEl.style.left = r.left + 'px';
    boxEl.style.top = r.top + 'px';
    boxEl.style.width = r.width + 'px';
    boxEl.style.height = r.height + 'px';
    tipEl.textContent = lastSel;
    tipEl.style.display = 'block';
    tipEl.style.left = Math.max(4, Math.min(r.left, innerWidth - 120)) + 'px';
    tipEl.style.top = (r.top > 26 ? r.top - 23 : Math.min(r.bottom + 6, innerHeight - 24)) + 'px';
  }

  function onMove(e) {
    if (!picking) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === lastEl) return;
    if (el.getAttribute && el.getAttribute('data-hermit-preview-pick') !== null) return;
    lastEl = el;
    lastSel = selectorFor(el);
    paint();
  }

  function onScroll() { if (picking) paint(); }

  function swallow(e) { e.preventDefault(); e.stopPropagation(); }

  function onDown(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    var sel = el === lastEl && lastSel ? lastSel : selectorFor(el);
    stopPick(true);
    up({
      type: 'picked',
      selector: sel,
      selectorPath: selectorPathFor(el),
      tag: el.tagName.toLowerCase(),
      label: labelFor(el),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    });
  }

  function onKey(e) {
    if (!picking || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    stopPick(false);
    up({ type: 'pick-cancel' });
  }

  function startPick() {
    if (picking) return;
    chrome();
    // A pick started inside the previous pick's swallow window would otherwise
    // be disarmed by that window closing — and the click it was supposed to eat
    // reaches the page.
    if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }
    picking = true;
    lastEl = null;
    lastSel = '';
    styleEl = document.createElement('style');
    styleEl.setAttribute('data-hermit-preview-pick', '');
    styleEl.textContent = '*{cursor:crosshair !important}';
    (document.head || document.documentElement).appendChild(styleEl);
    document.addEventListener('pointerover', onMove, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('mouseup', swallow, true);
    document.addEventListener('click', swallow, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
  }

  // pointerdown is where a pick lands, but the browser still delivers the
  // mouseup and click behind it. Keep eating those for a moment, or the picked
  // link navigates the moment you pick it.
  function stopPick(eatTrailingClick) {
    if (!picking) return;
    picking = false;
    document.removeEventListener('pointerover', onMove, true);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('mousedown', swallow, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    styleEl = null;
    if (boxEl) boxEl.style.display = 'none';
    if (tipEl) tipEl.style.display = 'none';
    lastEl = null;
    var drop = function () {
      dropTimer = null;
      document.removeEventListener('mouseup', swallow, true);
      document.removeEventListener('click', swallow, true);
    };
    if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }
    if (eatTrailingClick) dropTimer = setTimeout(drop, 400); else drop();
  }

  // ── the panel's dismissal drag, when the finger is on THIS page ─────────
  // On a phone the panel is a full-screen layer and this document fills it, so
  // the swipe that puts it away lands here — in an origin the panel cannot read
  // touches from, however hard it tries. Watch for one and describe it upward;
  // the panel does the moving, so all the numbers stay on that side.
  //
  // What is NOT a dismissal: a tap, a vertical scroll, a leftward drag, a drag
  // while the element picker is armed, and — the one that would be infuriating —
  // a drag over something that can still scroll that way itself, e.g. a wide
  // code block pushed to the right. Those keep the page's own behaviour.
  var sw = null;

  // Pages that mean to handle horizontal drags themselves: a range input, a
  // slider, a draggable, or anything that has taken touch-action away from the
  // browser (canvas apps, carousels, map panes). Dismissing the panel out from
  // under one of those would make the preview useless for exactly the pages
  // most worth previewing.
  var OWNS = 'input,select,textarea,[role=slider],[role=scrollbar],[draggable=true],[contenteditable=""],[contenteditable=true]';

  function ownsTouch(el) {
    for (var n = el, i = 0; n && n.nodeType === 1 && i < 8; n = n.parentElement, i++) {
      try { if (n.matches(OWNS)) return true; } catch (e) {}
      var ta = '';
      try { ta = getComputedStyle(n).touchAction || ''; } catch (e) {}
      if (ta && ta !== 'auto' && ta !== 'manipulation') return true;
    }
    return false;
  }

  function absorbsRight(el) {
    for (var n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.scrollLeft > 0) return true;
    }
    var se = document.scrollingElement;
    return !!(se && se.scrollLeft > 0);
  }

  // screenX, not clientX. The panel slides THIS DOCUMENT sideways as the drag
  // goes, so a coordinate measured against this viewport shrinks by however far
  // the panel has already travelled — the finger appears to move at half speed
  // and the panel stalls at half the distance. Screen coordinates do not move
  // when the frame does.
  addEventListener('touchstart', function (e) {
    if (picking || e.touches.length !== 1) { sw = null; return; }
    var t = e.touches[0];
    sw = { x0: t.screenX, y0: t.screenY, x: t.screenX, t: e.timeStamp, dx: 0, vx: 0, on: false, dead: false };
  }, { passive: true });

  addEventListener('touchmove', function (e) {
    if (!sw || sw.dead || e.touches.length !== 1) return;
    var t = e.touches[0];
    var dx = t.screenX - sw.x0, dy = t.screenY - sw.y0;
    if (!sw.on) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;   // still undecided
      if (dx <= 0 || Math.abs(dx) <= Math.abs(dy) || absorbsRight(e.target) || ownsTouch(e.target)) { sw.dead = true; return; }
      sw.on = true;
      up({ type: 'swipe', phase: 'start' });
    }
    // Cancelable only until the browser has committed to a scroll of its own;
    // asking after that is a console warning and nothing else.
    if (e.cancelable) e.preventDefault();
    var now = e.timeStamp;
    if (now > sw.t) sw.vx = (t.screenX - sw.x) / (now - sw.t);
    sw.x = t.screenX; sw.t = now; sw.dx = dx;
    up({ type: 'swipe', phase: 'move', dx: dx });
  }, { passive: false });

  function endSwipe(e) {
    if (sw && sw.on) {
      // A finger that has held still is not flicking any more, whatever it was
      // doing a moment ago. Report no speed and let the panel decide on
      // distance, or parking it half-out and lifting is settled by a flick that
      // ended a second earlier.
      var stale = !!e && e.timeStamp - sw.t > 80;
      up({ type: 'swipe', phase: 'end', dx: sw.dx, vx: stale ? 0 : sw.vx });
    }
    sw = null;
  }
  addEventListener('touchend', endSwipe, { passive: true });
  addEventListener('touchcancel', endSwipe, { passive: true });

  // ── commands from the panel ─────────────────────────────────────────────
  addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.source !== IN) return;
    if (ev.source !== window.parent) return;
    if (d.type === 'nav') {
      var delta = d.delta > 0 ? 1 : -1;
      var n = window.navigation;
      // Where the browser can tell us, refuse a traversal this frame does not
      // own — one step too far walks the joint history and takes the dashboard
      // with it.
      if (n && typeof n.canGoBack === 'boolean' && (delta < 0 ? !n.canGoBack : !n.canGoForward)) return;
      try { history.go(delta); } catch (e) {}
    } else if (d.type === 'reload') {
      try { location.reload(); } catch (e) {}
    } else if (d.type === 'pick') {
      if (d.on) startPick(); else stopPick(false);
    } else if (d.type === 'hello') {
      report();
    }
  });

  report();
})();`;
}

/** The bridge, as a script tag ready to drop into a document. */
export function bridgeSnippet(nonce?: string | null): string {
  return `<script data-hermit-preview-bridge${nonceAttr(nonce)}>try{${bridgeClient()}}catch(e){}</script>`;
}
