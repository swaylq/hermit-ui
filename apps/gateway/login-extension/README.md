# Hermit Login Bridge (Chrome extension)

Lets the hermit gateway drive **this** Chrome — your real, everyday profile — to log
Claude Code into an account. Because it runs inside your genuine browser (real
trust history, no `navigator.webdriver`, no CDP), Cloudflare treats it as you,
which a Playwright-launched Chrome can't pull off.

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
3. **Load the extension:** open `chrome://extensions` → turn on **Developer mode**
   (top-right) → **Load unpacked** → select this folder
   (`~/hermit-ui/apps/gateway/login-extension`).
4. **Connect it:** click the extension's toolbar icon → leave URL as
   `ws://127.0.0.1:47615` → paste the **token** → **Save & Connect**. The dot
   should go green ("connected to gateway").

## Use

In the dashboard → Settings → **Account Login**, paste the account line and start.
The login now runs in this Chrome (a visible tab opens). If Cloudflare ever shows
a checkbox, solve it once in that tab — it won't loop like the automated browser did.

## Notes

- Bound to `127.0.0.1` only + token-gated — no remote reach.
- If the icon dot isn't green, the gateway isn't running or the token is wrong.
- The gateway falls back to its built-in (Playwright) Chrome when no extension is
  connected — so an unconfigured extension just means the old behaviour.
