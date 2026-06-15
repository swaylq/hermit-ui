const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get(['url', 'token']);
  $('url').value = s.url || 'ws://127.0.0.1:47615';
  $('token').value = s.token || '';
  refresh();
}

function refresh() {
  chrome.runtime.sendMessage('status', (st) => {
    const dot = $('dot');
    const state = $('state');
    const map = {
      connected: ['ok', 'connected to gateway'],
      connecting: ['wait', 'connecting…'],
      unreachable: ['wait', 'gateway unreachable — is it running on :47615?'],
      'bad-token': ['off', 'token rejected — re-copy ~/.hermit/login-bridge.json'],
      unconfigured: ['off', 'not configured'],
    };
    const [cls, text] = map[st] || ['off', st || '…'];
    dot.className = 'dot ' + cls;
    state.textContent = text;
  });
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ url: $('url').value.trim(), token: $('token').value.trim() });
  chrome.runtime.sendMessage('reconnect', () => setTimeout(refresh, 500));
});

// ── account auto-login ──────────────────────────────────────────────────────
$('login').addEventListener('click', () => {
  const parts = $('account').value.trim().split('----').map((s) => s.trim());
  const email = parts[0] || '';
  const emailPassword = parts[1] || '';
  const mailToken = parts[2] || ''; // parts[3] = sk — intentionally dropped here, never sent
  if (!email || !mailToken) {
    $('phead').textContent = '格式不对：邮箱----邮箱密码----接码令牌----sk';
    $('phead').className = 'phead error';
    return;
  }
  $('account').value = ''; // clear the secret from the field
  chrome.runtime.sendMessage({ type: 'login', email, emailPassword, mailToken }, (r) => {
    if (r === 'not-connected') {
      $('phead').textContent = '未连接网关——先 Save & Connect';
      $('phead').className = 'phead error';
    }
  });
});

function renderProgress() {
  chrome.runtime.sendMessage('getLoginState', (st) => {
    if (!st) return;
    const labels = { idle: '', running: '… 进行中', 'needs-human': '⚠ 需要人工', done: '✓ 完成', error: '✗ 失败' };
    $('phead').textContent = labels[st.status] || '';
    $('phead').className = 'phead ' + (st.status || '');
    $('progress').textContent = (st.lines || []).slice(-12).join('\n');
  });
}

load();
setInterval(refresh, 1500);
setInterval(renderProgress, 1000);
