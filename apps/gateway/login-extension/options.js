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
    dot.className = 'dot ' + (st === 'connected' ? 'ok' : st === 'connecting' ? 'wait' : 'off');
    state.textContent = st === 'connected' ? 'connected to gateway' : st === 'connecting' ? 'connecting…' : 'not configured';
  });
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ url: $('url').value.trim(), token: $('token').value.trim() });
  chrome.runtime.sendMessage('reconnect', () => setTimeout(refresh, 500));
});

load();
setInterval(refresh, 1500);
