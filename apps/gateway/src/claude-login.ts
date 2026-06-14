// Orchestrator for switching THIS machine's Claude Code account.
//
// Drives a browser through the claude.ai email-code login (codes fetched from the
// 171mail receiver), then runs `claude auth login` (node-pty) and completes the
// OAuth authorize in that same logged-in browser. Two backends behind one
// LoginDriver interface:
//   • ExtensionDriver — drives the user's REAL Chrome via the MV3 extension
//     (real profile + trust history, no webdriver, no CDP). Used when the
//     extension is connected; this is what actually beats Cloudflare Turnstile.
//   • PlaywrightDriver — rebrowser-playwright-core fallback (stealth-patched, but
//     a fresh profile, so Cloudflare may still challenge).
// Any stuck step flips to `needs-human`: the window is on THIS Mac, a person
// clears it, and we auto-continue. The flow can be aborted (manual reset).
//
// SECRETS: mail token, login codes, magic-links, and the OAuth code#state are
// NEVER logged or surfaced — only high-level, redacted lines.

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { BrowserContext, Page } from 'rebrowser-playwright-core';
import { execCapture } from './exec';
import { isExtensionConnected, sendCommand } from './login-bridge';

type IPty = ReturnType<typeof pty.spawn>;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const PROFILE_DIR = path.join(os.homedir(), '.hermit', 'claude-login', 'chrome-profile');
const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

const NAV_TIMEOUT = 60_000;
const STEP_TIMEOUT = 25_000;
const HUMAN_WAIT_MS = 8 * 60_000;
const CODE_WAIT_MS = 4 * 60_000;
const POLL_MS = 2_500;

// claude.ai / 171mail selectors (querySelector-compatible; role/text fallbacks live in clickByText)
const EMAIL_SEL = 'input[data-testid="email"], input[type="email"], input[name="email"]';
const CONTINUE_SEL = 'button[data-testid="continue"]'; // claude.ai "Continue with email" + code-submit
const CODE_SEL = 'input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]';
const COMPOSER_SEL = 'div[contenteditable="true"], nav a[href*="/chat"], [data-testid*="composer"]';
const CF_SEL =
  'iframe[src*="challenges.cloudflare.com"], iframe[title*="Cloudflare"], #challenge-running, #cf-challenge-running';

export type LoginReport = (u: { status?: 'running' | 'needs-human'; line?: string }) => void | Promise<void>;

export interface ClaudeLoginInput {
  email: string;
  mailToken: string;
  emailPassword?: string | null;
  claudeBin?: string;
  report: LoginReport;
}
export interface ClaudeLoginResult {
  ok: boolean;
  email?: string;
  summary: string;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── manual reset / abort ──────────────────────────────────────────────────────
let activeAbort: AbortController | null = null;
export function abortActiveLogin(): void {
  activeAbort?.abort();
}
function checkAbort(): void {
  if (activeAbort?.signal.aborted) throw new Error('已手动重置');
}

// ── browser abstraction ────────────────────────────────────────────────────────
type Tab = 'login' | 'mail';
interface LoginDriver {
  navigate(url: string, tab?: Tab): Promise<void>;
  currentUrl(tab?: Tab): Promise<string>;
  title(tab?: Tab): Promise<string>;
  exists(selector: string, tab?: Tab): Promise<boolean>;
  bodyText(tab?: Tab): Promise<string>;
  inputValues(tab?: Tab): Promise<string[]>;
  findCodeState(tab?: Tab): Promise<string>; // scrape the OAuth code#state in-page (pre/code first)
  fill(selector: string, value: string, tab?: Tab): Promise<boolean>;
  pressEnter(selector: string, tab?: Tab): Promise<boolean>;
  click(selector: string, tab?: Tab): Promise<boolean>;
  clickByText(pattern: string, tab?: Tab): Promise<boolean>;
  nudge(tab?: Tab): Promise<boolean>; // synthetic pointer move — wakes anti-bot-disabled buttons
  openUserMenu(tab?: Tab): Promise<boolean>; // claude.ai bottom-left avatar (no text → can't clickByText)
  closeTab(tab: Tab): Promise<void>;
  dispose(): Promise<void>;
}

// Drives the user's real Chrome through the MV3 extension over the localhost bridge.
class ExtensionDriver implements LoginDriver {
  navigate(url: string, tab: Tab = 'login') {
    return sendCommand<void>('navigate', { url, tab }, NAV_TIMEOUT + 5_000);
  }
  async currentUrl(tab: Tab = 'login') {
    return (await sendCommand<string>('url', { tab })) || '';
  }
  async title(tab: Tab = 'login') {
    return (await sendCommand<string>('title', { tab })) || '';
  }
  async exists(selector: string, tab: Tab = 'login') {
    return !!(await sendCommand('exists', { selector, tab }));
  }
  async bodyText(tab: Tab = 'login') {
    return (await sendCommand<string>('bodyText', { tab })) || '';
  }
  async inputValues(tab: Tab = 'login') {
    return (await sendCommand<string[]>('inputValues', { tab })) || [];
  }
  async findCodeState(tab: Tab = 'login') {
    return (await sendCommand<string>('findCodeState', { tab })) || '';
  }
  async fill(selector: string, value: string, tab: Tab = 'login') {
    return !!(await sendCommand('fill', { selector, value, tab }));
  }
  async pressEnter(selector: string, tab: Tab = 'login') {
    return !!(await sendCommand('pressEnter', { selector, tab }));
  }
  async click(selector: string, tab: Tab = 'login') {
    return !!(await sendCommand('click', { selector, tab }));
  }
  async clickByText(pattern: string, tab: Tab = 'login') {
    return !!(await sendCommand('clickByText', { pattern, tab }));
  }
  async nudge(tab: Tab = 'login') {
    return !!(await sendCommand('nudge', { tab }));
  }
  async openUserMenu(tab: Tab = 'login') {
    return !!(await sendCommand('openUserMenu', { tab }));
  }
  async closeTab(tab: Tab) {
    await sendCommand('closeTab', { tab }).catch(() => {});
  }
  async dispose() {
    await this.closeTab('mail');
    await this.closeTab('login');
  }
}

// rebrowser-playwright-core fallback (stealth-patched, but a fresh profile).
class PlaywrightDriver implements LoginDriver {
  private pages: { login?: Page; mail?: Page } = {};
  constructor(
    private ctx: BrowserContext,
    firstPage: Page,
  ) {
    this.pages.login = firstPage;
  }
  private async page(tab: Tab): Promise<Page> {
    if (!this.pages[tab]) this.pages[tab] = await this.ctx.newPage();
    return this.pages[tab]!;
  }
  async navigate(url: string, tab: Tab = 'login') {
    await (await this.page(tab)).goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  }
  async currentUrl(tab: Tab = 'login') {
    return (await this.page(tab)).url();
  }
  async title(tab: Tab = 'login') {
    return (await this.page(tab)).title().catch(() => '');
  }
  async exists(selector: string, tab: Tab = 'login') {
    try {
      return await (await this.page(tab)).locator(selector).first().isVisible({ timeout: 800 });
    } catch {
      return false;
    }
  }
  async bodyText(tab: Tab = 'login') {
    return (await this.page(tab))
      .locator('body')
      .innerText()
      .catch(() => '');
  }
  async inputValues(tab: Tab = 'login') {
    return (await this.page(tab))
      .$$eval('input, a, textarea', (els: any[]) => els.map((e: any) => e.value || e.href || '').filter(Boolean))
      .catch(() => [] as string[]);
  }
  async findCodeState() {
    return ''; // Playwright path resolves code#state via bodyText/inputValues below
  }
  async fill(selector: string, value: string, tab: Tab = 'login') {
    try {
      await (await this.page(tab)).locator(selector).first().fill(value, { timeout: STEP_TIMEOUT });
      return true;
    } catch {
      return false;
    }
  }
  async pressEnter(selector: string, tab: Tab = 'login') {
    try {
      await (await this.page(tab)).locator(selector).first().press('Enter');
      return true;
    } catch {
      return false;
    }
  }
  async click(selector: string, tab: Tab = 'login') {
    try {
      await (await this.page(tab)).locator(selector).first().click({ timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
  async clickByText(pattern: string, tab: Tab = 'login') {
    try {
      const p = await this.page(tab);
      const re = new RegExp(pattern, 'i');
      await p
        .getByRole('button', { name: re })
        .or(p.getByRole('link', { name: re }))
        .or(p.getByRole('menuitem', { name: re }))
        .first()
        .click({ timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
  async nudge(tab: Tab = 'login') {
    try {
      const p = await this.page(tab);
      await p.mouse.move(300, 300);
      await p.mouse.move(520, 420);
      return true;
    } catch {
      return false;
    }
  }
  async openUserMenu(tab: Tab = 'login') {
    const p = await this.page(tab);
    for (const sel of [
      '[data-testid="user-menu-button"]',
      'button[aria-label*="profile" i]',
      'button[aria-label*="account" i]',
      'button[aria-haspopup="menu"]',
    ]) {
      const loc = p.locator(sel).first();
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        await loc.click().catch(() => {});
        return true;
      }
    }
    return false;
  }
  async closeTab(tab: Tab) {
    await this.pages[tab]?.close().catch(() => {});
    this.pages[tab] = undefined;
  }
  async dispose() {
    await this.ctx.close().catch(() => {});
  }
}

// ── flow (driver-agnostic) ──────────────────────────────────────────────────────
async function emailFieldVisible(d: LoginDriver): Promise<boolean> {
  return d.exists(EMAIL_SEL);
}
async function loggedIntoClaude(d: LoginDriver): Promise<boolean> {
  if (await emailFieldVisible(d)) return false; // login page → signed out
  // The account menu only exists when signed in — the most reliable signal,
  // independent of URL or whether the sidebar is collapsed.
  if (await d.exists('[data-testid="user-menu-button"]')) return true;
  if (/\/(new|chats?|projects)\b/.test(await d.currentUrl())) return true;
  return d.exists(COMPOSER_SEL);
}
async function cloudflareChallenged(d: LoginDriver): Promise<boolean> {
  if (/just a moment|attention required|checking (your|if)/i.test(await d.title())) return true;
  return d.exists(CF_SEL);
}

// Wait until check() holds; if it stalls or a Cloudflare wall is up, flip to
// needs-human and keep polling up to HUMAN_WAIT_MS, then continue.
async function until(
  d: LoginDriver,
  report: LoginReport,
  check: () => Promise<boolean>,
  opts: { humanMsg: string; softMs?: number },
): Promise<void> {
  const soft = Date.now() + (opts.softMs ?? STEP_TIMEOUT);
  while (Date.now() < soft) {
    checkAbort();
    if (await check()) return;
    if (await cloudflareChallenged(d)) break;
    await sleep(POLL_MS);
  }
  if (await check()) return;
  await report({ status: 'needs-human', line: opts.humanMsg });
  const hard = Date.now() + HUMAN_WAIT_MS;
  while (Date.now() < hard) {
    checkAbort();
    await sleep(POLL_MS);
    if (await check()) {
      await report({ status: 'running', line: '✓ 已就绪，继续…' });
      return;
    }
  }
  throw new Error('等待人工处理超时（没人在这台 Mac 的 Chrome 里完成操作）');
}

async function clearCloudflare(d: LoginDriver, report: LoginReport, where: string): Promise<void> {
  if (!(await cloudflareChallenged(d))) return;
  await until(d, report, async () => !(await cloudflareChallenged(d)), {
    humanMsg: `⚠️ ${where}遇到 Cloudflare 人机验证 — 请在 Chrome 窗口里完成验证，完成后自动继续…`,
  });
}

async function logoutClaudeWeb(d: LoginDriver, report: LoginReport): Promise<void> {
  await report({ line: '检测到已登录，先退出当前账号（左下角头像 → Log out）…' });
  // Open the bottom-left avatar menu ONCE (re-clicking the trigger toggles it
  // shut), then poll for the "Log out" item — the base-ui menu animates in.
  await d.openUserMenu();
  let out = false;
  for (let i = 0; i < 8 && !out; i++) {
    checkAbort();
    await sleep(600);
    out = await d.clickByText('log ?out|sign ?out|退出|登出');
  }
  // Fallback: the Log out item is <a href="/logout"> — hit the route directly.
  if (!out) await d.navigate('https://claude.ai/logout').catch(() => {});
  await until(d, report, () => emailFieldVisible(d), {
    humanMsg: '请在 Chrome 里点左下角头像 → Log out 退出当前账号（之后自动继续）。',
  });
}

// ── 171mail code / magic-link retrieval (in the 'mail' tab) ────────────────────
async function fetchLoginCode(d: LoginDriver, token: string, report: LoginReport): Promise<{ code?: string; magicLink?: string }> {
  await d.navigate(`https://b.171mail.com/#/home/code?type=claude&token=${encodeURIComponent(token)}`, 'mail');
  await report({ line: '打开 171mail，等待登录链接…' });
  await d.clickByText('获取验证码|获取|get code', 'mail').catch(() => false);

  const deadline = Date.now() + CODE_WAIT_MS;
  let lastClick = Date.now();
  while (Date.now() < deadline) {
    checkAbort();
    const links = await d.inputValues('mail').catch(() => [] as string[]);
    const body = await d.bodyText('mail').catch(() => '');
    const magic =
      links.find((v) => /claude\.ai\/magic-link/i.test(v)) ||
      body.match(/https:\/\/claude\.ai\/magic-link[^\s"'<>]*/i)?.[0];
    if (magic) {
      await report({ line: '收到登录链接。' });
      return { magicLink: magic };
    }
    const m = body.match(/(?<!\d)(\d{6})(?!\d)/);
    if (m) {
      await report({ line: '收到 6 位验证码。' });
      return { code: m[1] };
    }
    if (Date.now() - lastClick > 15_000) {
      await d.clickByText('获取验证码|获取|get code', 'mail').catch(() => false);
      lastClick = Date.now();
    }
    await sleep(POLL_MS);
  }
  throw new Error('171mail 未取到验证码（邮件未到 / 令牌无效）');
}

// ── CLI OAuth ──────────────────────────────────────────────────────────────────
const CODE_STATE_RE = /[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{20,}/;
async function codeStateOnPage(d: LoginDriver): Promise<string | null> {
  const direct = await d.findCodeState().catch(() => '');
  if (direct) {
    const dm = direct.match(CODE_STATE_RE);
    if (dm) return dm[0];
  }
  const body = await d.bodyText().catch(() => '');
  let m = body.match(CODE_STATE_RE);
  if (m) return m[0];
  for (const v of await d.inputValues().catch(() => [] as string[])) {
    m = v.match(CODE_STATE_RE);
    if (m) return m[0];
  }
  return null;
}

// Open the authorize URL in the (already target-account) login tab, click
// Authorize, then scrape code#state for paste-mode or let loopback finish.
async function driveOAuth(d: LoginDriver, url: string, report: LoginReport, sendCode: (cs: string) => void): Promise<void> {
  await report({ line: '在浏览器里打开授权页…' });
  await d.navigate(url);
  await clearCloudflare(d, report, '授权页');

  // claude.ai's Authorize button starts disabled until a pointer move (anti-bot),
  // and a disabled button ignores clicks. Nudge the page, then click once it's
  // live (clickByText skips disabled matches, so it only fires when real). If it
  // stays stuck past the soft window, ask the human to wiggle the mouse / click —
  // and keep trying so a human mouse-move + our click still lands it.
  await report({ line: '在授权页点 Authorize（按钮要先「醒」过来）…' });
  let clicked = false;
  let askedHuman = false;
  const soft = Date.now() + 12_000;
  const hard = Date.now() + HUMAN_WAIT_MS;
  while (Date.now() < hard) {
    checkAbort();
    if ((await codeStateOnPage(d)) !== null) break; // already authorized
    await d.nudge();
    if (await d.clickByText('authorize|allow|授权|允许')) {
      clicked = true;
      await report({ line: '已点 Authorize…' });
      break;
    }
    if (!askedHuman && Date.now() > soft) {
      askedHuman = true;
      await report({ status: 'needs-human', line: '请在授权页移动一下鼠标让 Authorize 变黑、点它（之后自动继续）。' });
    }
    await sleep(1_200);
  }
  if (askedHuman && clicked) await report({ status: 'running', line: '✓ 已授权，继续…' });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    checkAbort();
    const cs = await codeStateOnPage(d);
    if (cs) {
      await report({ line: '回填授权码…' });
      sendCode(cs);
      return;
    }
    await sleep(1_500);
  }
  await report({ line: '未见 code#state，按本地回调模式等待 CLI 完成…' });
}

// Pull the OAuth authorize URL out of `claude auth login` output. The PATH/$BROWSER
// shim echoes "OPENURL <url>", and the CLI also usually prints it for copy-paste.
function findOAuthUrl(raw: string): string | null {
  const urls = (raw.replace(ANSI_RE, '').match(/https:\/\/[^\s"'<>]+/g) || []).map((u) => u.replace(/[.,;:)\]}'"]+$/, ''));
  return urls.find((u) => /oauth|authoriz|claude\.(ai|com)|anthropic/i.test(u)) || urls[0] || null;
}
// Redact secrets before showing CLI output in the progress log.
function redactTerm(s: string): string {
  return s
    .replace(ANSI_RE, '')
    .replace(/[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{20,}/g, '<code#state>')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***')
    .replace(/[A-Za-z0-9_-]{40,}/g, '<token>');
}

async function cliLogin(d: LoginDriver, email: string, claudeBin: string, report: LoginReport): Promise<void> {
  await report({ line: '切换 Claude Code CLI 账号（claude auth login）…' });
  await execCapture('bash', ['-lc', `export PATH="${LOCAL_BIN}:$PATH"; claude auth logout`], { timeoutMs: 20_000 }).catch(
    () => {},
  );
  const which = await execCapture('bash', ['-lc', `export PATH="${LOCAL_BIN}:$PATH"; command -v claude`], {
    timeoutMs: 10_000,
  });
  const claudeAbs = which.stdout.trim() || claudeBin;

  // PATH shim: turn the CLI's browser-open into a URL we capture (and stop a stray
  // real browser from racing the OAuth on the wrong account).
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-login-'));
  fs.writeFileSync(path.join(shimDir, 'open'), '#!/bin/sh\necho "OPENURL $@"\n', { mode: 0o755 });
  const cleanup = () => {
    try {
      fs.rmSync(shimDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  const term: IPty = pty.spawn(claudeAbs, ['auth', 'login', '--claudeai', '--email', email], {
    name: 'xterm-color',
    cols: 1000, // wide so a long OAuth URL never soft-wraps in the pty
    rows: 40,
    env: {
      ...process.env,
      PATH: `${shimDir}:${LOCAL_BIN}:${process.env.PATH ?? ''}`,
      BROWSER: path.join(shimDir, 'open'), // tools honoring $BROWSER hit our URL-capturing shim too
    },
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let urlHandled = false;
    let raw = '';
    const sig = activeAbort?.signal;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        term.kill();
      } catch {
        /* already gone */
      }
      err ? reject(err) : resolve();
    };
    const onAbort = () => finish(new Error('已手动重置'));
    if (sig?.aborted) onAbort();
    else sig?.addEventListener('abort', onAbort);

    let lastStream = 0;
    term.onData((chunk: string) => {
      raw += chunk;
      if (urlHandled) return;
      const url = findOAuthUrl(raw);
      if (url) {
        urlHandled = true;
        driveOAuth(d, url, report, (cs) => {
          try {
            term.write(cs + '\r');
          } catch {
            /* term may have exited (loopback already finished) */
          }
        }).catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
        return;
      }
      // Diagnostic: surface what `claude auth login` is showing while we wait for
      // the URL (throttled, secrets redacted) — so a stuck prompt is visible.
      const now = Date.now();
      if (now - lastStream > 2_000) {
        lastStream = now;
        const tail = redactTerm(raw)
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(-2)
          .join(' ⏎ ')
          .slice(-180);
        if (tail) void report({ line: `claude: ${tail}` });
      }
    });
    term.onExit(({ exitCode }: { exitCode: number }) => {
      if (!urlHandled) return finish(new Error('未能从 claude auth login 捕获授权 URL'));
      if (exitCode !== 0) return finish(new Error(`claude auth login 退出码 ${exitCode}`));
      finish();
    });
  });
}

// ── auth status verification ──────────────────────────────────────────────────
function parseAuthStatus(out: string): { loggedIn: boolean; email?: string } {
  try {
    const j = JSON.parse(out.trim());
    const loggedIn = j?.loggedIn === true || j?.isAuthenticated === true || j?.authenticated === true || !!j?.account;
    const email = j?.email ?? j?.account?.email ?? j?.user?.email ?? undefined;
    return { loggedIn, email };
  } catch {
    const loggedIn = /"loggedIn"\s*:\s*true|logged ?in\s*[:=]?\s*true/i.test(out);
    const m = out.match(/"email"\s*:\s*"([^"]+)"/) ?? out.match(/[\w.+-]+@[\w.-]+\.\w+/);
    return { loggedIn, email: m ? (m[1] ?? m[0]) : undefined };
  }
}
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
function redactEmail(e: string): string {
  const [u, dom] = e.split('@');
  return dom ? `${u.slice(0, 2)}***@${dom}` : '***';
}

// ── entry point ───────────────────────────────────────────────────────────────
async function buildDriver(report: LoginReport): Promise<LoginDriver> {
  if (isExtensionConnected()) {
    await report({ status: 'running', line: '用你的 Chrome 扩展驱动真实浏览器（过 Cloudflare）…' });
    return new ExtensionDriver();
  }
  await report({ status: 'running', line: '扩展未连接，回退到内置 Chrome（可能被 Cloudflare 挡）…' });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const { chromium } = await import('rebrowser-playwright-core');
  let ctx: BrowserContext;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    throw new Error(
      '启动 Chrome 失败——这台机器可能没装 Google Chrome（请先装 Chrome 再试）。' +
        `原始错误：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  ctx.setDefaultTimeout(STEP_TIMEOUT);
  ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
  return new PlaywrightDriver(ctx, ctx.pages()[0] ?? (await ctx.newPage()));
}

export async function runClaudeLogin(input: ClaudeLoginInput): Promise<ClaudeLoginResult> {
  const { email, mailToken, report } = input;
  const claudeBin = input.claudeBin ?? 'claude';

  const abort = new AbortController();
  activeAbort = abort;

  let driver: LoginDriver | null = null;
  try {
    const d = await buildDriver(report);
    driver = d;

    // 1. claude.ai → clean login page
    await report({ line: '打开 claude.ai…' });
    await d.navigate('https://claude.ai/login');
    await clearCloudflare(d, report, 'claude.ai');
    // Let the SPA settle (a signed-in session redirects /login → /new), then
    // decide: signed in (→ log out) or already at the email login form.
    for (let i = 0; i < 6; i++) {
      if ((await emailFieldVisible(d)) || (await loggedIntoClaude(d))) break;
      await sleep(1_000);
    }
    if (await loggedIntoClaude(d)) await logoutClaudeWeb(d, report);
    await until(d, report, () => emailFieldVisible(d), { humanMsg: '请在 Chrome 里停在 claude.ai 的邮箱登录界面。' });

    // 2. enter email → triggers the login email. Click "Continue with email"
    // SPECIFICALLY — a bare "continue" match grabs the "Continue with Google" SSO
    // button. Fall back to pressing Enter in the email field.
    await report({ line: '输入邮箱并继续（走邮箱，不走 Google）…' });
    await d.fill(EMAIL_SEL, email);
    if (!(await d.click(CONTINUE_SEL)) && !(await d.clickByText('continue with email|用邮箱|使用邮箱'))) {
      await d.pressEnter(EMAIL_SEL);
    }
    // Nothing else on claude.ai now — login finishes by opening the link from 171mail.

    // 3. 171mail → wait for the login link (or 6-digit code)
    const got = await fetchLoginCode(d, mailToken, report);
    await d.closeTab('mail');
    if (got.magicLink) {
      await report({ line: '用 magic-link 登录…' });
      await d.navigate(got.magicLink);
    } else if (got.code) {
      await report({ line: '填入验证码并验证…' });
      await d.fill(CODE_SEL, got.code);
      if (!(await d.click(CONTINUE_SEL)) && !(await d.clickByText('verify( email address)?|submit|continue|验证|继续'))) {
        await d.pressEnter(CODE_SEL);
      }
    }
    await until(d, report, () => loggedIntoClaude(d), {
      humanMsg: '请在 Chrome 里完成 claude.ai 登录（到达对话界面）。',
      softMs: 40_000,
    });
    await report({ line: '✓ claude.ai 网页已登录目标账号。' });

    // 4. CLI OAuth in the same browser
    await cliLogin(d, email, claudeBin, report);

    // 5. verify
    const st = await execCapture('bash', ['-lc', `export PATH="${LOCAL_BIN}:$PATH"; claude auth status --json`], {
      timeoutMs: 20_000,
    });
    const parsed = parseAuthStatus(st.stdout);
    if (!parsed.loggedIn) throw new Error('claude auth status 显示未登录');
    if (parsed.email && !sameEmail(parsed.email, email)) throw new Error('已登录，但不是目标账号');
    const shown = redactEmail(parsed.email ?? email);
    await report({ status: 'running', line: `✓ Claude Code CLI 已登录：${shown}` });
    return { ok: true, email: parsed.email ?? email, summary: `网页 + CLI 均已登录 ${shown}（重启该机器的 session 后生效）` };
  } catch (e) {
    return { ok: false, summary: '登录失败', error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (activeAbort === abort) activeAbort = null;
    await driver?.dispose().catch(() => {});
  }
}
