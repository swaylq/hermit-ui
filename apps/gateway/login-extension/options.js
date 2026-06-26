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

load();
setInterval(refresh, 1500);
