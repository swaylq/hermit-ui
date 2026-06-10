// Headed-Chrome orchestrator for switching THIS machine's Claude Code account.
//
// Drives the claude.ai email-code login (codes fetched from the 171mail receiver)
// in a persistent Chrome profile, then runs `claude auth login` (via the stdlib
// pty helper) and completes the OAuth authorize in that already-logged-in browser.
// Any step that stalls — a Cloudflare wall, an unexpected page — flips to
// `needs-human`: the visible Chrome window is on THIS Mac, a person clears it,
// and we auto-continue when the success condition is met.
//
// SECRETS: the mail token, login codes, magic-links, and the OAuth `code#state`
// are NEVER written to logs or the progress stream — only high-level, redacted
// lines. Playwright is dynamically imported so it never loads unless a login runs.

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
// rebrowser-playwright-core: a stealth-patched drop-in for playwright-core. Its
// Runtime.enable fix (on unless REBROWSER_PATCHES_RUNTIME_FIX_MODE="0") closes the
// main CDP tell Cloudflare Turnstile uses; combined with stripping the automation
// launch flags below, navigator.webdriver is false and the browser reads as human.
import type { BrowserContext, Page } from 'rebrowser-playwright-core';
import { execCapture } from './exec';

type IPty = ReturnType<typeof pty.spawn>;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// The authorize URL the CLI prints (or hands to `open`) — a claude.ai / anthropic OAuth link.
const URL_RE = /https:\/\/[^\s"'<>]*(?:claude\.ai|anthropic\.com)\/[^\s"'<>]*/;

const PROFILE_DIR = path.join(os.homedir(), '.hermit', 'claude-login', 'chrome-profile');
const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin'); // native `claude` lives here

const NAV_TIMEOUT = 60_000;
const STEP_TIMEOUT = 25_000; // best-effort wait for a normal step before asking a human
const HUMAN_WAIT_MS = 8 * 60_000; // how long we'll wait for a person at the Mac to unstick it
const CODE_WAIT_MS = 4 * 60_000; // how long to wait for the login email to land at 171mail
const POLL_MS = 2_500;

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
// Only one login runs at a time (the machine-request `busy` guard serializes
// them), so a module-level controller is safe. The dashboard's "reset" marks the
// request resolved; the gateway's login-cancel tick then calls abortActiveLogin(),
// and these checks bail the flow at the next loop tick (closing Chrome on the way).
let activeAbort: AbortController | null = null;
export function abortActiveLogin(): void {
  activeAbort?.abort();
}
function checkAbort(): void {
  if (activeAbort?.signal.aborted) throw new Error('已手动重置');
}

// ── tolerant DOM probes (role/text based — claude.ai markup churns) ────────────
async function visible(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 800 });
  } catch {
    return false;
  }
}
async function emailFieldVisible(page: Page): Promise<boolean> {
  return (await visible(page, 'input[type="email"]')) || (await visible(page, 'input[name="email"]'));
}
async function loggedIntoClaude(page: Page): Promise<boolean> {
  if (/\/(new|chats?|projects)\b/.test(page.url())) return true;
  if (await emailFieldVisible(page)) return false;
  return await visible(page, 'div[contenteditable="true"], nav a[href*="/chat"], [data-testid*="composer"]');
}
async function cloudflareChallenged(page: Page): Promise<boolean> {
  try {
    const title = (await page.title().catch(() => '')) || '';
    if (/just a moment|attention required|checking (your|if)/i.test(title)) return true;
    return await visible(
      page,
      'iframe[src*="challenges.cloudflare.com"], iframe[title*="Cloudflare"], #challenge-running, #cf-challenge-running',
    );
  } catch {
    return false;
  }
}

// Wait until check() holds. First the normal way (soft window); if it still isn't
// — or a Cloudflare wall is up — flip to needs-human and keep polling up to
// HUMAN_WAIT_MS so a person at this Mac's Chrome can clear it, then continue.
async function until(
  page: Page,
  report: LoginReport,
  check: () => Promise<boolean>,
  opts: { humanMsg: string; softMs?: number },
): Promise<void> {
  const soft = Date.now() + (opts.softMs ?? STEP_TIMEOUT);
  while (Date.now() < soft) {
    checkAbort();
    if (await check()) return;
    if (await cloudflareChallenged(page)) break; // don't burn the soft window behind a CF wall
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

async function clearCloudflare(page: Page, report: LoginReport, where: string): Promise<void> {
  if (!(await cloudflareChallenged(page))) return;
  await until(page, report, async () => !(await cloudflareChallenged(page)), {
    humanMsg: `⚠️ ${where}遇到 Cloudflare 人机验证 — 请在这台 Mac 的 Chrome 窗口完成验证，完成后自动继续…`,
  });
}

// ── claude.ai login steps ─────────────────────────────────────────────────────
async function logoutClaudeWeb(page: Page, report: LoginReport): Promise<void> {
  await report({ line: '检测到已登录，先退出当前账号…' });
  try {
    const menu = page.getByRole('button', { name: /account|profile|settings|账户|设置/i }).first();
    await menu.click({ timeout: 5_000 });
    await page
      .getByRole('menuitem', { name: /log ?out|sign ?out|退出|登出/i })
      .first()
      .click({ timeout: 5_000 });
  } catch {
    try {
      await page.goto('https://claude.ai/logout', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch {
      /* fall through to the human gate */
    }
  }
  await until(page, report, () => emailFieldVisible(page), {
    humanMsg: '请在 Chrome 里退出当前 claude.ai 账号（回到邮箱登录页）。',
  });
}

async function fillEmailAndContinue(page: Page, email: string): Promise<void> {
  const field = page.locator('input[type="email"], input[name="email"]').first();
  await field.fill(email, { timeout: STEP_TIMEOUT });
  const cont = page.getByRole('button', { name: /continue with email|continue|继续/i }).first();
  try {
    await cont.click({ timeout: 5_000 });
  } catch {
    await field.press('Enter');
  }
}

async function codeEntryReady(page: Page): Promise<boolean> {
  if (await visible(page, 'input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]')) return true;
  const btn = page.getByRole('button', { name: /enter verification code|use a (login )?code|输入验证码/i }).first();
  try {
    if (await btn.isVisible({ timeout: 600 })) {
      await btn.click({ timeout: 2_000 });
      return await visible(page, 'input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]');
    }
  } catch {
    /* not this variant */
  }
  return false;
}

async function enterCode(page: Page, code: string): Promise<void> {
  const single = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]').first();
  try {
    await single.fill(code, { timeout: 5_000 });
  } catch {
    const boxes = page.locator('input[maxlength="1"]');
    const n = await boxes.count().catch(() => 0);
    if (n >= code.length) for (let i = 0; i < code.length; i++) await boxes.nth(i).fill(code[i]).catch(() => {});
  }
  const verify = page.getByRole('button', { name: /verify( email address)?|submit|continue|验证|继续/i }).first();
  try {
    await verify.click({ timeout: 5_000 });
  } catch {
    await single.press('Enter').catch(() => {});
  }
}

// ── 171mail code / magic-link retrieval ───────────────────────────────────────
async function fetchLoginCode(
  mailPage: Page,
  token: string,
  report: LoginReport,
): Promise<{ code?: string; magicLink?: string }> {
  await mailPage.goto(`https://b.171mail.com/#/home/code?type=claude&token=${encodeURIComponent(token)}`, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT,
  });
  await report({ line: '打开 171mail 接码页，等待验证码…' });
  const fetchBtn = mailPage.getByRole('button', { name: /获取验证码|获取|get code/i }).first();
  try {
    await fetchBtn.click({ timeout: 5_000 });
  } catch {
    /* may auto-fetch */
  }

  const deadline = Date.now() + CODE_WAIT_MS;
  let lastClick = Date.now();
  while (Date.now() < deadline) {
    checkAbort();
    const links: string[] = await mailPage
      .$$eval('input, a', (els: any[]) => els.map((e: any) => e.value || e.href || '').filter(Boolean))
      .catch(() => [] as string[]);
    const magic = links.find((v) => /https:\/\/claude\.ai\/magic-link/i.test(v));
    if (magic) {
      await report({ line: '收到 magic-link。' });
      return { magicLink: magic };
    }
    const body = await mailPage.locator('body').innerText().catch(() => '');
    const m = body.match(/(?<!\d)(\d{6})(?!\d)/);
    if (m) {
      await report({ line: '收到 6 位验证码。' });
      return { code: m[1] };
    }
    if (Date.now() - lastClick > 15_000) {
      try {
        await fetchBtn.click({ timeout: 3_000 });
      } catch {
        /* ignore */
      }
      lastClick = Date.now();
    }
    await sleep(POLL_MS);
  }
  throw new Error('171mail 未取到验证码（邮件未到 / 令牌无效）');
}

// ── CLI OAuth (pty helper + drive the authorize page) ─────────────────────────
function codeStateRe(): RegExp {
  return /\b[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{20,}\b/;
}
async function codeStateOnPage(page: Page): Promise<string | null> {
  const re = codeStateRe();
  try {
    const body = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
    let m = body.match(re);
    if (m) return m[0];
    const vals: string[] = await page
      .$$eval('input, textarea, code, pre', (els: any[]) => els.map((e: any) => e.value || e.textContent || ''))
      .catch(() => [] as string[]);
    for (const v of vals) {
      m = v.match(re);
      if (m) return m[0];
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Open the authorize URL in the (already target-account) browser, click Authorize,
// and either scrape the code#state for paste-mode or let the loopback redirect
// finish on its own.
async function driveOAuth(
  ctx: BrowserContext,
  url: string,
  report: LoginReport,
  sendCode: (codeState: string) => void,
): Promise<void> {
  const page = await ctx.newPage();
  try {
    await report({ line: '在浏览器里打开授权页…' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await clearCloudflare(page, report, '授权页');

    const authorize = page.getByRole('button', { name: /authorize|allow|授权|允许/i }).first();
    await until(
      page,
      report,
      async () => (await authorize.isVisible({ timeout: 600 }).catch(() => false)) || (await codeStateOnPage(page)) !== null,
      { humanMsg: '请在 Chrome 的授权页点击 Authorize。' },
    );
    try {
      await authorize.click({ timeout: 5_000 });
    } catch {
      /* maybe already past it (code#state already shown) */
    }

    // Paste-mode shows a code#state; loopback-mode redirects to localhost and the
    // CLI finishes itself. Poll briefly for a code; if none, assume loopback.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      checkAbort();
      const cs = await codeStateOnPage(page);
      if (cs) {
        await report({ line: '回填授权码…' });
        sendCode(cs);
        return;
      }
      await sleep(1_500);
    }
    await report({ line: '未见 code#state，按本地回调模式等待 CLI 完成…' });
  } finally {
    await page.close().catch(() => {});
  }
}

async function cliLogin(
  ctx: BrowserContext,
  email: string,
  claudeBin: string,
  report: LoginReport,
): Promise<void> {
  await report({ line: '切换 Claude Code CLI 账号（claude auth login）…' });
  // Clean switch — drop whatever the CLI was on first.
  await execCapture('bash', ['-lc', `export PATH="${LOCAL_BIN}:$PATH"; claude auth logout`], { timeoutMs: 20_000 }).catch(
    () => {},
  );

  // Resolve claude's absolute path — node-pty/execvp PATH resolution is unreliable
  // under launchd's minimal PATH (see the launchd_path note), so pass an absolute bin.
  const which = await execCapture('bash', ['-lc', `export PATH="${LOCAL_BIN}:$PATH"; command -v claude`], {
    timeoutMs: 10_000,
  });
  const claudeAbs = which.stdout.trim() || claudeBin;

  // PATH shim: turn the CLI's browser-open into a URL we capture, and stop a stray
  // real browser from racing the OAuth on the wrong account.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-login-'));
  fs.writeFileSync(path.join(shimDir, 'open'), '#!/bin/sh\necho "OPENURL $@"\n', { mode: 0o755 });
  const cleanup = () => {
    try {
      fs.rmSync(shimDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  // node-pty gives `claude auth login` the real TTY it needs; we scrape the
  // authorize URL from its output and type the code#state straight back in.
  const term: IPty = pty.spawn(claudeAbs, ['auth', 'login', '--claudeai', '--email', email], {
    name: 'xterm-color',
    cols: 100,
    rows: 30,
    env: { ...process.env, PATH: `${shimDir}:${LOCAL_BIN}:${process.env.PATH ?? ''}`, BROWSER: 'true' },
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

    term.onData((d: string) => {
      raw += d;
      if (!urlHandled) {
        const m = raw.replace(ANSI_RE, '').match(URL_RE);
        if (m) {
          urlHandled = true;
          driveOAuth(ctx, m[0], report, (cs) => {
            try {
              term.write(cs + '\r'); // pty Enter is CR
            } catch {
              /* term may have exited (loopback redirect already finished) */
            }
          }).catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
        }
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
function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
function redactEmail(e: string): string {
  const [u, d] = e.split('@');
  if (!d) return '***';
  return `${u.slice(0, 2)}***@${d}`;
}

// ── entry point ───────────────────────────────────────────────────────────────
export async function runClaudeLogin(input: ClaudeLoginInput): Promise<ClaudeLoginResult> {
  const { email, mailToken, report } = input;
  const claudeBin = input.claudeBin ?? 'claude';
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const abort = new AbortController();
  activeAbort = abort;

  const { chromium } = await import('rebrowser-playwright-core');
  let ctx: BrowserContext | null = null;
  try {
    await report({ status: 'running', line: '启动 Chrome（有头）…' });
    try {
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: 'chrome',
        headless: false,
        viewport: null,
        // Stealth: drop --enable-automation (kills the "controlled by automated
        // software" infobar) and force navigator.webdriver=false, so Cloudflare
        // doesn't re-challenge on every navigation.
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
      });
    } catch (e) {
      throw new Error(
        '启动 Chrome 失败——这台机器可能没装 Google Chrome（登录用系统 Chrome 过 Cloudflare，请先装 Chrome 再试）。' +
          `原始错误：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    ctx.setDefaultTimeout(STEP_TIMEOUT);
    ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    // 1. claude.ai → clean login page
    await report({ line: '打开 claude.ai…' });
    await page.goto('https://claude.ai/login', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await clearCloudflare(page, report, 'claude.ai');
    if (await loggedIntoClaude(page)) await logoutClaudeWeb(page, report);
    await until(page, report, () => emailFieldVisible(page), {
      humanMsg: '请在 Chrome 里停在 claude.ai 的邮箱登录界面。',
    });

    // 2. enter email → triggers the login email
    await report({ line: '输入邮箱并继续…' });
    await fillEmailAndContinue(page, email);
    await until(page, report, () => codeEntryReady(page), {
      humanMsg: '请在 Chrome 里进入「输入验证码」界面。',
    });

    // 3. fetch the code / magic-link from 171mail (separate tab)
    const mailPage = await ctx.newPage();
    let got: { code?: string; magicLink?: string };
    try {
      got = await fetchLoginCode(mailPage, mailToken, report);
    } finally {
      await mailPage.close().catch(() => {});
    }
    if (got.magicLink) {
      await report({ line: '用 magic-link 登录…' });
      await page.goto(got.magicLink, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } else if (got.code) {
      await report({ line: '填入验证码并验证…' });
      await enterCode(page, got.code);
    }
    await until(page, report, () => loggedIntoClaude(page), {
      humanMsg: '请在 Chrome 里完成 claude.ai 登录（到达对话界面）。',
      softMs: 40_000,
    });
    await report({ line: '✓ claude.ai 网页已登录目标账号。' });

    // 4. CLI OAuth in the same (target-account) browser
    await cliLogin(ctx, email, claudeBin, report);

    // 5. verify the machine's Claude Code is now on the target account
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
    await ctx?.close().catch(() => {});
  }
}
