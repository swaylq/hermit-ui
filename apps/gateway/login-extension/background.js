// Hermit Login Bridge — MV3 background service worker.
//
// Connects to the gateway's localhost WS bridge and executes DOM commands in a
// dedicated, VISIBLE login tab via chrome.scripting (runs in the real profile,
// no CDP, no automation flags — so Cloudflare treats it as the human it is).
// The gateway is the brain (sequencing/regex); this is just the hands.

let ws = null;
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
  return 'connecting';
}

function connect() {
  if (!cfg.token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const u = cfg.url + (cfg.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(cfg.token);
  try {
    ws = new WebSocket(u);
  } catch {
    ws = null;
    return;
  }
  ws.onclose = () => {
    ws = null;
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
    ws = null;
  };
  ws.onmessage = async (ev) => {
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
    case 'inputValues':
      return await runInTab(which, domInputValues, []);
    case 'fill':
      return await runInTab(which, domFill, [args.selector, args.value]);
    case 'click':
      return await runInTab(which, domClick, [args.selector]);
    case 'clickByText':
      return await runInTab(which, domClickByText, [args.pattern]);
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
  const el = document.querySelector(selector);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
}
function domText(selector) {
  const el = document.querySelector(selector);
  return el ? (el.innerText || el.textContent || '').trim() : '';
}
function domBodyText() {
  return document.body ? document.body.innerText : '';
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
function domClick(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.click();
  return true;
}
function domClickByText(pattern) {
  const re = new RegExp(pattern, 'i');
  const els = Array.from(
    document.querySelectorAll('button, a, [role="button"], [role="menuitem"], input[type="submit"], input[type="button"]'),
  );
  const hit = els.find((e) => re.test(((e.innerText || e.textContent || e.value || '') + '').trim()));
  if (!hit) return false;
  hit.click();
  return true;
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
