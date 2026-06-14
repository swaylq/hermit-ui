// Hermit Login Bridge — MV3 background service worker.
//
// Connects to the gateway's localhost WS bridge and executes DOM commands in a
// dedicated, VISIBLE login tab via chrome.scripting (runs in the real profile,
// no CDP, no automation flags — so Cloudflare treats it as the human it is).
// The gateway is the brain (sequencing/regex); this is just the hands.

let ws = null;
let lastClose = null; // { code, reason } of the last drop — drives a useful status
let tabs = { login: null, mail: null }; // 171mail runs in its own tab so the live claude.ai page survives
let cfg = { url: 'ws://127.0.0.1:47615', token: '' };

async function loadCfg() {
  const s = await chrome.storage.local.get(['url', 'token']);
  cfg.url = s.url || 'ws://127.0.0.1:47615';
  cfg.token = s.token || '';
}

function wsState() {
  if (ws && ws.readyState === WebSocket.OPEN) return 'connected';
  if (!cfg.token) return 'unconfigured';
  if (lastClose && lastClose.code === 4001) return 'bad-token'; // gateway rejected the token
  if (lastClose && lastClose.code) return 'unreachable'; // closed/refused → gateway not listening
  return 'connecting';
}

function connect() {
  if (!cfg.token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const u = cfg.url + (cfg.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(cfg.token);
  let sock;
  try {
    sock = new WebSocket(u);
  } catch {
    lastClose = { code: 1006, reason: 'ctor' };
    ws = null;
    return;
  }
  ws = sock;
  // Don't let a half-open socket sit in CONNECTING forever.
  const t = setTimeout(() => {
    if (sock.readyState === WebSocket.CONNECTING) {
      try {
        sock.close();
      } catch {}
      if (ws === sock) ws = null;
      lastClose = { code: 1006, reason: 'timeout' };
    }
  }, 6000);
  sock.onopen = () => {
    clearTimeout(t);
    lastClose = null;
  };
  sock.onclose = (ev) => {
    clearTimeout(t);
    lastClose = { code: ev.code, reason: ev.reason || '' };
    if (ws === sock) ws = null;
  };
  sock.onerror = () => {
    clearTimeout(t);
    try {
      sock.close();
    } catch {}
    if (ws === sock) ws = null;
  };
  sock.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const { id, op, args } = msg || {};
    try {
      const result = await handle(op, args || {});
      send({ id, ok: true, result });
    } catch (e) {
      send({ id, ok: false, error: String((e && e.message) || e) });
    }
  };
}

function send(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

// ── tab management ──────────────────────────────────────────────────────────
async function ensureTab(which) {
  which = which || 'login';
  if (tabs[which] != null) {
    try {
      await chrome.tabs.get(tabs[which]);
      return tabs[which];
    } catch {
      tabs[which] = null;
    }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: which === 'login' });
  tabs[which] = tab.id;
  return tabs[which];
}

async function waitForLoad(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  await new Promise((r) => setTimeout(r, 350)); // let navigation start
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function runInTab(which, func, args = []) {
  const tabId = await ensureTab(which);
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res ? res.result : undefined;
}

// ── command dispatch ────────────────────────────────────────────────────────
// Every op may target tab 'login' (default) or 'mail'.
async function handle(op, args) {
  const which = args.tab || 'login';
  switch (op) {
    case 'ping':
      return 'pong';
    case 'navigate': {
      const tabId = await ensureTab(which);
      await chrome.tabs.update(tabId, { url: args.url, active: which === 'login' });
      await waitForLoad(tabId);
      return true;
    }
    case 'url': {
      const tabId = await ensureTab(which);
      const t = await chrome.tabs.get(tabId);
      return t.url || '';
    }
    case 'title': {
      const tabId = await ensureTab(which);
      const t = await chrome.tabs.get(tabId);
      return t.title || '';
    }
    case 'exists':
      return await runInTab(which, domExists, [args.selector]);
    case 'text':
      return await runInTab(which, domText, [args.selector]);
    case 'bodyText':
      return await runInTab(which, domBodyText, []);
    case 'findCodeState':
      return await runInTab(which, domFindCodeState, []);
    case 'inputValues':
      return await runInTab(which, domInputValues, []);
    case 'fill':
      return await runInTab(which, domFill, [args.selector, args.value]);
    case 'pressEnter':
      return await runInTab(which, domPressEnter, [args.selector]);
    case 'click':
      return await runInTab(which, domClick, [args.selector]);
    case 'clickByText':
      return await runInTab(which, domClickByText, [args.pattern]);
    case 'nudge':
      return await runInTab(which, domNudge, []);
    case 'openUserMenu':
      return await runInTab(which, domOpenUserMenu, []);
    case 'closeTab': {
      if (tabs[which] != null) {
        try {
          await chrome.tabs.remove(tabs[which]);
        } catch {}
        tabs[which] = null;
      }
      return true;
    }
    default:
      throw new Error('unknown op: ' + op);
  }
}

// ── injected DOM functions (run in the page; isolated world, DOM only) ────────
function domExists(selector) {
  // ANY visible match — querySelector's first hit may be a hidden duplicate
  // (e.g. the expanded-sidebar user-menu-button when the sidebar is collapsed).
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') return true;
  }
  return false;
}
function domText(selector) {
  const el = document.querySelector(selector);
  return el ? (el.innerText || el.textContent || '').trim() : '';
}
function domBodyText() {
  return document.body ? document.body.innerText : '';
}
// Extract the OAuth code#state. Scan pre/code/textarea/input (the paste page puts
// it in a <pre>) first, then the whole body — innerText alone can miss a <pre>.
function domFindCodeState() {
  const re = /[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{20,}/;
  for (const el of document.querySelectorAll('pre, code, textarea, input')) {
    const v = el.value || el.innerText || el.textContent || '';
    const m = v.match(re);
    if (m) return m[0];
  }
  const m = (document.body ? document.body.innerText : '').match(re);
  return m ? m[0] : '';
}
function domInputValues() {
  const out = [];
  document.querySelectorAll('input, a, textarea').forEach((e) => {
    const v = e.value || e.href || '';
    if (v) out.push(v);
  });
  return out;
}
function domFill(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.focus();
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
// Real click = full pointer/mouse sequence. base-ui (claude.ai) triggers open on
// pointerdown, so a bare .click() doesn't open the account menu. Inlined per
// function because chrome.scripting.executeScript injects one self-contained fn.
function domClick(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  const o = { bubbles: true, cancelable: true, view: window };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    try {
      el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
    } catch {}
  }
  return true;
}
// Human-like pointer movement — some pages (claude.ai's OAuth Authorize) keep the
// button disabled until they see pointer movement. We dispatch a moving PATH (with
// movementX/Y + screen coords), and specifically hover the Authorize button.
// (These are synthetic so isTrusted=false; if the page demands trusted input the
// human still has to wiggle the real mouse — but this clears the common cases.)
function domNudge() {
  const w = window.innerWidth || 1200;
  const h = window.innerHeight || 800;
  let btn = null;
  for (const b of document.querySelectorAll('button')) {
    if (/^\s*(authorize|allow|授权|允许)\s*$/i.test((b.innerText || b.textContent || '').trim())) {
      btn = b;
      break;
    }
  }
  const path = [
    [w * 0.25, h * 0.3],
    [w * 0.4, h * 0.42],
    [w * 0.5, h * 0.5],
    [w * 0.55, h * 0.6],
  ];
  if (btn) {
    const r = btn.getBoundingClientRect();
    path.push([r.left + r.width / 2, r.top + r.height / 2]);
  }
  let px = w * 0.2;
  let py = h * 0.2;
  for (const [clientX, clientY] of path) {
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      movementX: clientX - px,
      movementY: clientY - py,
    };
    px = clientX;
    py = clientY;
    const tgts = [document, document.body || document.documentElement];
    if (btn) tgts.push(btn);
    for (const tgt of tgts) {
      try {
        tgt.dispatchEvent(new PointerEvent('pointermove', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      } catch {}
      try {
        tgt.dispatchEvent(new MouseEvent('mousemove', base));
      } catch {}
    }
  }
  if (btn) {
    const r = btn.getBoundingClientRect();
    const c = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
      try {
        btn.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { ...c, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      } catch {}
    }
  }
  return true;
}
function domPressEnter(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.focus();
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }
  const form = el.closest('form');
  if (form) {
    try {
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
    } catch {}
  }
  return true;
}
function domClickByText(pattern) {
  const re = new RegExp(pattern, 'i');
  const els = Array.from(
    document.querySelectorAll('button, a, [role="button"], [role="menuitem"], input[type="submit"], input[type="button"]'),
  );
  // Skip disabled matches (e.g. claude.ai's Authorize starts disabled until a
  // pointer move) so the caller keeps retrying instead of "clicking" a dead
  // button; and prefer a VISIBLE match over hidden duplicates.
  const ok = (e) => !e.disabled && re.test(((e.innerText || e.textContent || e.value || '') + '').trim());
  const visEl = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && e.offsetParent !== null;
  };
  const hit = els.find((e) => ok(e) && visEl(e)) || els.find(ok);
  if (!hit) return false;
  const o = { bubbles: true, cancelable: true, view: window };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    try {
      hit.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
    } catch {}
  }
  return true;
}
// Open the claude.ai account menu — the bottom-left avatar (no useful text, so
// clickByText can't find it). Try known handles, then a heuristic: a button in
// the bottom-left corner that pops a menu / holds an avatar.
function domOpenUserMenu() {
  const o = { bubbles: true, cancelable: true, view: window };
  const rc = (el) => {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
      } catch {}
    }
  };
  // Prefer the VISIBLE match — when the sidebar is collapsed there are two
  // user-menu-buttons in the DOM (the expanded one hidden), and querySelector
  // would grab the hidden one so the click no-ops.
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  };
  const known = [
    '[data-testid="user-menu-button"]',
    'button[aria-label*="profile" i]',
    'button[aria-label*="account" i]',
    'button[aria-label*="user menu" i]',
    'button[aria-haspopup="menu"]',
  ];
  for (const sel of known) {
    const els = Array.from(document.querySelectorAll(sel));
    const el = els.find(vis) || els[0];
    if (el) {
      rc(el);
      return true;
    }
  }
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const cands = Array.from(document.querySelectorAll('button')).filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > vh * 0.6 && r.left < vw * 0.3;
  });
  cands.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom); // lowest first
  const pick =
    cands.find((b) => b.getAttribute('aria-haspopup')) ||
    cands.find((b) => b.querySelector('img, [class*="avatar" i], [style*="background-image" i]')) ||
    cands[0];
  if (pick) {
    rc(pick);
    return true;
  }
  return false;
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => loadCfg().then(connect));
chrome.runtime.onStartup.addListener(() => loadCfg().then(connect));
chrome.storage.onChanged.addListener(() => {
  loadCfg().then(() => {
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    connect();
  });
});
// Keepalive: MV3 kills idle service workers; this wakes it ~every 24s to keep the
// WS up / reconnect. During an active login, command traffic keeps it alive anyway.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => loadCfg().then(connect));
// Popup status/reconnect requests.
chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m === 'status') {
    reply(wsState());
  } else if (m === 'reconnect') {
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    loadCfg().then(connect);
    reply('ok');
  }
  return true;
});

loadCfg().then(connect);
