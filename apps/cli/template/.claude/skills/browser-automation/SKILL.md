---
name: browser-automation
description: "Browser automation via self-managed Chrome + Playwright CDP. Use when: (1) automating browser workflows (scrape, fill forms, login, publish), (2) exploring a web page to understand its structure, (3) converting explorations into replayable zero-token scripts. NOT for: simple URL fetches (use WebFetch instead)."
---

# Browser Automation

Explore (playwright-mcp) → Record (script) → Replay (browser-lock.sh). Self-managed Chrome, no external browser service required.

## Architecture

```
Chrome (self-managed, CDP 19900-19999)
  ├── profile:  <agent-dir>/browser/user-data/
  ├── config:   <agent-dir>/browser/chrome.json
  └── CDP port: auto-assigned
       ↕ CDP
┌─────────────────────┐     ┌──────────────────────┐
│ playwright-mcp      │     │ Standalone scripts    │
│ (interactive)       │ ──→ │ (replay, zero token)  │
└─────────────────────┘     └──────────────────────┘
  After exploring, record as a script; browser-lock.sh runs it.
```

**Requires:** `npm install playwright` inside the agent directory (done during init).

## Chrome Management

```bash
./scripts/chrome-launcher.sh start     # launch (auto port, auto profile)
./scripts/chrome-launcher.sh stop      # stop
./scripts/chrome-launcher.sh restart   # stop + start
./scripts/chrome-launcher.sh status    # show state
```

## Phase 1: Explore (playwright-mcp)

Default: use the `mcp__playwright-browser__*` MCP tools for interactive exploration.

**Core tools:**
- `browser_navigate` — open URL
- `browser_snapshot` — get accessibility tree (with `ref`)
- `browser_click` — click via ref
- `browser_type` — type via ref
- `browser_fill_form` — fill forms
- `browser_press_key` — press keys
- `browser_select_option` — dropdowns
- `browser_hover` / `browser_drag`
- `browser_file_upload`
- `browser_take_screenshot`
- `browser_wait_for`
- `browser_tabs` / `browser_navigate_back` / `browser_close`
- `browser_console_messages` / `browser_network_requests`
- `browser_evaluate` / `browser_run_code`

**Exploration flow:**
1. Ensure Chrome is running (`chrome-launcher.sh start`).
2. `browser_navigate` to target URL.
3. `browser_snapshot` to get elements + refs.
4. `browser_click`/`browser_type` + ref.
5. Repeat snapshot → act until the flow works.

Every MCP call returns the underlying Playwright code — that's the material you'll record.

## Phase 2: Record (save as script)

Collect Playwright snippets from the exploration and integrate into a reusable script:

1. Start from `scripts/browser/playwright-template.js`.
2. Save as `scripts/browser/<verb>-<target>.js` (e.g. `publish-blog.js`, `read-inbox.js`).
3. **Rules:**
   - Use `human-like.js` helpers instead of direct operations (anti-detection).
   - Apply `applyStealthToContext(context)` before opening any page.
   - `page.close()` in `finally`, **NEVER** `browser.close()`.
   - End with `process.exit(0)`.

**Conversion cheatsheet:**

| playwright-mcp output | In the script |
|-----------------------|---------------|
| `await page.goto(url)` | `await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })` |
| `await page.click(sel)` | `await humanClick(page, sel)` |
| `await page.fill(sel, text)` | `await humanType(page, sel, text)` |
| `await page.type(sel, text)` | `await humanType(page, sel, text)` |
| no delay | `await humanDelay(1000, 3000)` between steps |

## Phase 3: Replay

```bash
./scripts/browser-lock.sh run scripts/browser/<name>.js [args...]
./scripts/browser-lock.sh run --timeout 120 scripts/browser/<name>.js
```

`browser-lock.sh` auto-acquires a lock (prevents concurrent runs) → starts Chrome if needed → runs the script → releases the lock.

## Anti-Detection (MANDATORY)

All scripts must use anti-detection:

### Layer 1: Stealth (fingerprint)

```javascript
const { applyStealthToContext } = require('./utils/stealth');
await applyStealthToContext(context);  // BEFORE context.newPage()
```

### Layer 2: Human-Like (behavior)

| Banned | Required |
|--------|----------|
| `page.click(sel)` | `humanClick(page, sel)` |
| `page.fill(sel, text)` | `humanType(page, sel, text)` |
| `waitForTimeout(fixed)` | `humanDelay(min, max)` |
| act immediately after load | `humanBrowse(page)` to simulate reading |

### Module API

**human-like.js:** `humanDelay`, `humanThink`, `humanClick`, `humanType`, `humanFillContentEditable`, `humanBrowse`, `humanScroll`, `jitterWait`

**stealth.js:** `applyStealthToContext`, `applyStealthToPage`, `verifyStealthStatus`

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Lock held | `./scripts/browser-lock.sh release` |
| CDP timeout | `./scripts/chrome-launcher.sh restart` |
| Login expired | Relogin via playwright-mcp |
| Selector broken | Re-explore via playwright-mcp, update script |
