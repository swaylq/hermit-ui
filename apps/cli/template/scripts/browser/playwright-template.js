#!/usr/bin/env node
/**
 * Playwright Script Template — Browser Automation (claudeclaw)
 *
 * Usage: ./scripts/browser-lock.sh run scripts/browser/<name>.js [args]
 *
 * Rules:
 * - NEVER browser.close() — kills entire Chrome
 * - ALWAYS page.close() in finally block
 * - ALWAYS process.exit(0) at end
 * - ALWAYS use human-like functions for all interactions
 * - ALWAYS apply stealth before creating pages
 */

const { chromium } = require('playwright');
const {
  humanDelay, humanThink, humanClick, humanType,
  humanFillContentEditable, humanBrowse, humanScroll, jitterWait,
} = require('./utils/human-like');
const { applyStealthToContext } = require('./utils/stealth');
const path = require('path');
const fs = require('fs');

function discoverCdpUrl() {
  const chromeJson = path.join(__dirname, '..', '..', 'browser', 'chrome.json');
  if (fs.existsSync(chromeJson)) {
    try {
      const config = JSON.parse(fs.readFileSync(chromeJson, 'utf8'));
      if (config.cdp_port) return `http://127.0.0.1:${config.cdp_port}`;
    } catch (e) {}
  }
  const port = process.env.CDP_PORT || '19900';
  return `http://127.0.0.1:${port}`;
}

function log(msg) { console.log(`[TASK] ${msg}`); }
function err(msg) { console.error(`[ERROR] ${msg}`); }

async function main() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(discoverCdpUrl());
  } catch (e) {
    err('Cannot connect to CDP. Run: scripts/chrome-launcher.sh start');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  await applyStealthToContext(context);
  const page = await context.newPage();

  try {
    // ===== Your automation here =====
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(2000, 4000);
    log('Page loaded');

    await humanBrowse(page);
    await humanThink(800, 2000);
    await humanType(page, 'input[name="title"]', 'My Title');
    await humanClick(page, 'button[type="submit"]');

    await humanDelay(3000, 6000);
    log('Done');
  } catch (error) {
    err(error.message);
    await page.screenshot({ path: '/tmp/task-error.png' }).catch(() => {});
    process.exit(1);
  } finally {
    await page.close();
  }
}

main().then(() => process.exit(0)).catch(e => { err(e.message); process.exit(1); });
