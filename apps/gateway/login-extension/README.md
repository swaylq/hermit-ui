# Hermit Browser Bridge (Chrome extension)

A generic browser-automation bridge: it lets the hermit gateway drive **this**
Chrome — your real, everyday profile — over a localhost WebSocket. Because it
runs inside your genuine browser (real trust history, no `navigator.webdriver`,
no CDP for DOM ops; trusted CDP only for input), pages treat it as you.

> The account auto-login feature that originally used this was **removed** (too
> easy to get an account flagged). The extension + bridge are kept as reusable
> plumbing for future browser automation.

## One-time setup (per machine)

1. **Update + restart the gateway** so it serves the bridge and writes a token:
   ```bash
   cd ~/hermit-ui && git pull
   pm2 delete hermit-ui-gateway; pm2 start apps/gateway/ecosystem.config.cjs && pm2 save
   ```
2. **Get the token:**
   ```bash
   cat ~/.hermit/login-bridge.json     # → { "port": 47615, "token": "…" }
   ```
3. **Load the extension:** open `chrome://extensions` → **Developer mode** →
   **Load unpacked** → select this folder (`~/hermit-ui/apps/gateway/login-extension`).
4. **Connect it:** click the toolbar icon → leave URL `ws://127.0.0.1:47615` →
   paste the **token** → **Save & Connect**. The dot goes green when connected.

## How it works

The gateway calls `sendCommand(op, args)` over the bridge; the background worker
runs a fixed DOM vocabulary via `chrome.scripting.executeScript`
(navigate / click / fill / exists / bodyText / …) and trusted input via
`chrome.debugger`. Bound to `127.0.0.1` only + token-gated — no remote reach.
