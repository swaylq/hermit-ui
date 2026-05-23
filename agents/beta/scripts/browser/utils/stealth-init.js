
(() => {
  // 1. 移除 navigator.webdriver 标记
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  // 2. 修复 navigator.plugins
  if (navigator.plugins.length === 0) {
    const fakePluginData = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ];
    const fakePlugins = {
      length: fakePluginData.length,
      item: (i) => fakePluginData[i] || null,
      namedItem: (name) => fakePluginData.find(p => p.name === name) || null,
      refresh: () => {},
      [Symbol.iterator]: function* () { for (const p of fakePluginData) yield p; },
    };
    fakePluginData.forEach((p, i) => { fakePlugins[i] = p; });
    Object.defineProperty(navigator, 'plugins', {
      get: () => fakePlugins,
      configurable: true,
    });
  }

  // 3. 修复 navigator.languages
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en'],
      configurable: true,
    });
  }

  // 4. 修复 permissions API
  const originalQuery = window.Permissions?.prototype?.query;
  if (originalQuery) {
    window.Permissions.prototype.query = function(parameters) {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission });
      }
      return originalQuery.call(this, parameters);
    };
  }

  // 5. 清理 Playwright / CDP 特征变量
  for (const key of ['__playwright', '__pw_manual', '__PW_inspect']) {
    try { if (key in window) delete window[key]; } catch (e) {}
  }
  for (const key of Object.keys(window)) {
    if (key.startsWith('cdc_') || key.startsWith('$cdc_')) {
      try { delete window[key]; } catch (e) {}
    }
  }

  // 6. 修复 chrome.runtime
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    const nativeToString = 'function () { [native code] }';
    const runtime = {
      id: undefined,
      connect: function() { throw new Error('Could not establish connection. Receiving end does not exist.'); },
      sendMessage: function() { throw new Error('Could not establish connection. Receiving end does not exist.'); },
      getURL: function(path) { return ''; },
      getManifest: function() { return undefined; },
      onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      onInstalled: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    };
    for (const key of Object.keys(runtime)) {
      if (typeof runtime[key] === 'function') runtime[key].toString = () => nativeToString;
    }
    window.chrome.runtime = runtime;
  }
  if (!window.chrome.csi) {
    window.chrome.csi = function() {
      return { startE: Date.now(), onloadT: Date.now(), pageT: Math.random() * 1000 + 500, tran: 15 };
    };
  }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function() {
      return {
        commitLoadTime: Date.now() / 1000, connectionInfo: 'h2',
        finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0, firstPaintTime: Date.now() / 1000,
        navigationType: 'Other', npnNegotiatedProtocol: 'h2',
        requestTime: Date.now() / 1000 - 0.5, startLoadTime: Date.now() / 1000 - 0.5,
        wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true,
      };
    };
  }

  // 9. 修复 connection 信息
  if (navigator.connection) {
    const originalRtt = navigator.connection.rtt;
    if (originalRtt === 0 || originalRtt === undefined) {
      try {
        Object.defineProperty(navigator.connection, 'rtt', {
          get: () => 50 + Math.floor(Math.random() * 100),
          configurable: true, enumerable: true,
        });
      } catch (e) {}
    }
    const originalDownlink = navigator.connection.downlink;
    if (originalDownlink === 10) {
      try {
        Object.defineProperty(navigator.connection, 'downlink', {
          get: () => 5 + Math.random() * 10,
          configurable: true, enumerable: true,
        });
      } catch (e) {}
    }
  }

  // 10. WebGL vendor/renderer 兜底
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return getParameter.call(this, parameter) || 'Google Inc. (Apple)';
    if (parameter === 37446) return getParameter.call(this, parameter) || 'ANGLE (Apple, Apple M1, OpenGL 4.1)';
    return getParameter.call(this, parameter);
  };
})();
